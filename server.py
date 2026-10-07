"""Local server for xTracker.

Reads workout folders from Images, serves the app, and appends finished
workouts to data/completions.json so the calendar (and git) can use them.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import traceback
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA_FILE = ROOT / "data" / "completions.json"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
STATIC_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
}
MAX_UPLOAD = 80 * 1024 * 1024
DATA_LOCK = threading.Lock()
INVALID_NAME = re.compile(r'[<>:"|?*\x00-\x1f\\/]')
SPEC_RE = re.compile(
    r"^(?P<sets>\d+)\s*sets?\s*(?P<reps>\d+)\s*reps?\b\s*(?P<rest>.*)$",
    re.IGNORECASE | re.DOTALL,
)


def images_dir() -> Path:
    for name in ("Images", "images"):
        path = ROOT / name
        if path.is_dir():
            return path
    return ROOT / "Images"


def natural_key(value: str):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def parse_spec(spec: str):
    match = SPEC_RE.match(spec.strip())
    if not match:
        return None
    rest = match.group("rest").strip()
    qualifier = ""
    notes = ""
    if rest.startswith("-"):
        notes = rest.lstrip("-").strip()
    elif " - " in rest:
        qualifier, notes = [part.strip() for part in rest.split(" - ", 1)]
    elif "-" in rest:
        inline = re.match(r"^(.*?)\s*-\s*(.+)$", rest)
        if inline:
            qualifier = inline.group(1).strip()
            notes = inline.group(2).strip()
        else:
            qualifier = rest
    elif rest:
        qualifier = rest
    return {
        "sets": int(match.group("sets")),
        "reps": int(match.group("reps")),
        "qualifier": qualifier,
        "notes": notes,
    }


def parse_exercise(filename: str, fallback_order: int) -> dict:
    stem = Path(filename).stem.strip()
    parts = [part.strip() for part in stem.split(" - ")]
    order = fallback_order
    name = stem
    spec = ""
    extra: list[str] = []
    if parts and re.fullmatch(r"\d+", parts[0]):
        order = int(parts[0])
        if len(parts) > 1:
            name = parts[1]
        if len(parts) > 2:
            spec = parts[2]
            extra = parts[3:]

    parsed = parse_spec(spec) if spec else None
    if parsed is None:
        notes = " - ".join(part for part in [spec, *extra] if part)
        return {
            "order": order,
            "name": name,
            "sets": 1,
            "reps": None,
            "qualifier": "",
            "notes": notes,
            "file": filename,
            "unparsed": True,
        }

    notes = parsed["notes"]
    if extra:
        tail = " - ".join(extra)
        notes = " — ".join(part for part in (notes, tail) if part)
    return {
        "order": order,
        "name": name,
        "sets": parsed["sets"],
        "reps": parsed["reps"],
        "qualifier": parsed["qualifier"],
        "notes": notes,
        "file": filename,
        "unparsed": False,
    }


def write_workouts_manifest() -> None:
    payload = json.dumps(list_workouts(), indent=2) + "\n"
    path = ROOT / "workouts.json"
    if path.exists() and path.read_text(encoding="utf-8") == payload:
        return
    path.write_text(payload, encoding="utf-8")


def list_workouts() -> list[dict]:
    root = images_dir()
    if not root.is_dir():
        return []
    workouts = []
    for folder in sorted((path for path in root.iterdir() if path.is_dir() and not path.name.startswith(".")), key=lambda path: path.name.lower()):
        files = sorted(
            (
                path.name
                for path in folder.iterdir()
                if path.is_file() and not path.name.startswith(".") and path.suffix.lower() in IMAGE_EXTS
            ),
            key=natural_key,
        )
        exercises = [parse_exercise(name, index + 1) for index, name in enumerate(files)]
        exercises.sort(key=lambda item: (item["order"], item["file"].lower()))
        workouts.append({"id": folder.name, "exercises": exercises})
    return workouts


def read_completions() -> list[dict]:
    if not DATA_FILE.exists():
        return []
    text = DATA_FILE.read_text(encoding="utf-8").strip()
    if not text:
        return []
    data = json.loads(text)
    if not isinstance(data, list):
        raise ValueError("completions file must be a list")
    return data


def write_completions(items: list[dict]) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = DATA_FILE.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(items, indent=2) + "\n", encoding="utf-8")
    temporary.replace(DATA_FILE)


def clean_workout_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned or cleaned in {".", ".."} or len(cleaned) > 80 or INVALID_NAME.search(cleaned):
        raise ValueError("Use a plain folder name without slashes.")
    return cleaned


def clean_filename(name: str) -> str:
    base = Path(name).name.strip()
    if not base or base.startswith(".") or len(base) > 180 or INVALID_NAME.search(base):
        raise ValueError(f"Cannot use the file name {name!r}.")
    if Path(base).suffix.lower() not in IMAGE_EXTS:
        raise ValueError(f"{base} is not a png, jpg, gif, or webp image.")
    return base


def parse_multipart(body: bytes, content_type: str) -> dict:
    match = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', content_type, re.IGNORECASE)
    if not match:
        raise ValueError("Missing upload boundary")
    boundary = (match.group(1) or match.group(2)).strip().encode()
    fields: dict[str, list[str]] = {}
    files = []
    for part in body.split(b"--" + boundary)[1:]:
        if part.startswith(b"--"):
            break
        if part.startswith(b"\r\n"):
            part = part[2:]
        if part.endswith(b"\r\n"):
            part = part[:-2]
        header_blob, separator, data = part.partition(b"\r\n\r\n")
        if not separator:
            continue
        disposition = ""
        for line in header_blob.split(b"\r\n"):
            text = line.decode("utf-8", "replace")
            if text.lower().startswith("content-disposition:"):
                disposition = text.split(":", 1)[1].strip()
        if not disposition:
            continue
        name = header_param(disposition, "name")
        filename = filename_param(disposition)
        if filename is not None:
            files.append({"field": name, "filename": filename, "data": data})
        elif name is not None:
            fields.setdefault(name, []).append(data.decode("utf-8", "replace"))
    return {"fields": fields, "files": files}


def header_param(disposition: str, key: str):
    quoted = re.search(rf'(?:^|;)\s*{re.escape(key)}="([^"]*)"', disposition, re.IGNORECASE)
    if quoted:
        return quoted.group(1)
    plain = re.search(rf"(?:^|;)\s*{re.escape(key)}=([^;]+)", disposition, re.IGNORECASE)
    if plain:
        return plain.group(1).strip()
    return None


def filename_param(disposition: str):
    starred = re.search(r"filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)", disposition, re.IGNORECASE)
    if starred:
        return unquote(starred.group(1).strip().strip('"'))
    if re.search(r"filename\s*=", disposition, re.IGNORECASE):
        return header_param(disposition, "filename") or ""
    return None


def save_upload(body: bytes, content_type: str) -> dict:
    parsed = parse_multipart(body, content_type)
    names = parsed["fields"].get("name") or []
    if not names:
        raise ValueError("Enter a workout name.")
    workout_name = clean_workout_name(names[0])
    incoming = [item for item in parsed["files"] if item["filename"]]
    if not incoming:
        raise ValueError("Choose at least one exercise image.")
    folder = images_dir() / workout_name
    folder.mkdir(parents=True, exist_ok=True)
    root = images_dir().resolve()
    for item in incoming:
        filename = clean_filename(item["filename"])
        target = (folder / filename).resolve()
        if not target.is_relative_to(root):
            raise ValueError("That file would land outside the Images folder.")
        target.write_bytes(item["data"])
    workout = next(item for item in list_workouts() if item["id"] == workout_name)
    return workout


def git(args: list[str]) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_MERGE_AUTOEDIT"] = "no"
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=45,
        env=env,
        check=False,
    )


def git_error(result: subprocess.CompletedProcess) -> str:
    return " ".join((result.stderr or result.stdout or "").split())[:400]


def remote_log() -> list | None:
    fetched = git(["fetch", "origin", "main"])
    if fetched.returncode != 0:
        return None
    shown = git(["show", "origin/main:data/completions.json"])
    if shown.returncode != 0:
        return None
    try:
        data = json.loads(shown.stdout)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, list):
        return None
    return data


def merge_logs(local: list, remote: list, removed_id: str | None) -> list:
    merged = []
    seen = set()
    for item in [*remote, *local]:
        if not isinstance(item, dict):
            continue
        item_id = item.get("id")
        if not item_id or item_id in seen or item_id == removed_id:
            continue
        seen.add(item_id)
        merged.append(item)
    merged.sort(key=lambda item: item.get("completedAt", ""))
    return merged


def publish_log(message: str, removed_id: str | None = None) -> str | None:
    """Commit and push only the workout log. Returns an error string, or None."""
    try:
        return _publish_log(message, removed_id)
    except (OSError, subprocess.SubprocessError) as error:
        return "Saved on this computer. " + str(error)


def _publish_log(message: str, removed_id: str | None) -> str | None:
    remote = remote_log()
    if remote is not None:
        local = read_completions()
        merged = merge_logs(local, remote, removed_id)
        if merged != local:
            write_completions(merged)
    rel = "data/completions.json"
    added = git(["add", "--", rel])
    if added.returncode != 0:
        return "Saved on this computer. " + (git_error(added) or "Could not stage the workout log.")
    status = git(["status", "--porcelain", "--", rel])
    if status.returncode != 0:
        return "Saved on this computer. " + (git_error(status) or "Could not check the workout log.")
    staged = any(line and line[0] in "ADM" for line in status.stdout.splitlines())
    if staged:
        committed = git(["commit", "-m", message, "--", rel])
        if committed.returncode != 0:
            return "Saved on this computer. " + (git_error(committed) or "Could not commit the workout log.")
    if git(["rev-parse", "--verify", "HEAD"]).returncode != 0:
        return "Saved on this computer. There is no commit to push yet."
    pushed = git(["push", "origin", "HEAD:main"])
    if pushed.returncode != 0 and "rejected" in git_error(pushed).lower():
        pulled = git(["pull", "--rebase", "origin", "main"])
        if pulled.returncode != 0:
            git(["rebase", "--abort"])
            return "Saved on this computer. " + (git_error(pulled) or "GitHub had newer history and the update could not be rebased.")
        pushed = git(["push", "origin", "HEAD:main"])
    if pushed.returncode != 0:
        return "Saved on this computer. " + (git_error(pushed) or "GitHub push failed.")
    return None


def add_completion(payload: dict) -> dict:
    workout = payload.get("workout")
    completed_at = payload.get("completedAt")
    completed_on = payload.get("completedOn")
    if not isinstance(workout, str) or workout not in {item["id"] for item in list_workouts()}:
        raise ValueError("Unknown workout.")
    if not isinstance(completed_at, str) or not isinstance(completed_on, str):
        raise ValueError("Missing the completion time.")
    when = datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
    if when.tzinfo is None:
        raise ValueError("completedAt needs a timezone.")
    datetime.strptime(completed_on, "%Y-%m-%d")
    record = {
        "id": uuid.uuid4().hex,
        "workout": workout,
        "completedAt": when.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "completedOn": completed_on,
    }
    with DATA_LOCK:
        items = read_completions()
        items.append(record)
        write_completions(items)
        push_error = publish_log("Log a completed workout")
    return {**record, "pushed": push_error is None, "pushError": push_error or ""}


def delete_completion(record_id: str) -> dict | None:
    with DATA_LOCK:
        items = read_completions()
        kept = [item for item in items if item.get("id") != record_id]
        if len(kept) == len(items):
            return None
        write_completions(kept)
        push_error = publish_log("Remove a logged workout", removed_id=record_id)
    return {"ok": True, "pushed": push_error is None, "pushError": push_error or ""}


def image_file(workout: str, filename: str) -> Path | None:
    root = images_dir().resolve()
    if INVALID_NAME.search(workout) or INVALID_NAME.search(filename):
        return None
    folder = (root / workout).resolve()
    path = (folder / filename).resolve()
    if not folder.is_dir() or folder.parent != root:
        return None
    if path.parent != folder or not path.is_file():
        return None
    if path.suffix.lower() not in IMAGE_EXTS:
        return None
    return path


class Handler(BaseHTTPRequestHandler):
    server_version = "xTracker"

    def do_GET(self):
        try:
            self.route_get()
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "Something went wrong."})

    def do_POST(self):
        try:
            self.route_post()
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "Something went wrong."})

    def do_DELETE(self):
        try:
            self.route_delete()
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "Something went wrong."})

    def route_get(self):
        parsed = urlparse(self.path)
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        if parsed.path in {"/", "/index.html"}:
            self.send_file(ROOT / "index.html", STATIC_TYPES["index.html"])
            return
        if len(parts) == 1 and parts[0] in {"styles.css", "app.js", "workouts.json"}:
            content_type = STATIC_TYPES.get(parts[0], "application/json; charset=utf-8")
            self.send_file(ROOT / parts[0], content_type)
            return
        if parsed.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if parts == ["api", "workouts"]:
            self.send_json(200, list_workouts())
            return
        if parts == ["api", "completions"]:
            with DATA_LOCK:
                items = read_completions()
            items.sort(key=lambda item: item.get("completedAt", ""))
            self.send_json(200, items)
            return
        if len(parts) == 3 and parts[0] == "media":
            path = image_file(parts[1], parts[2])
            if path is None:
                self.send_json(404, {"error": "Image not found."})
                return
            self.send_file(path, IMAGE_TYPES.get(path.suffix.lower(), "application/octet-stream"))
            return
        self.send_json(404, {"error": "Not found."})

    def route_post(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length < 0 or length > MAX_UPLOAD:
            self.send_json(413, {"error": "That upload is too large."})
            return
        body = self.rfile.read(length) if length else b""
        if parsed.path == "/api/completions":
            try:
                payload = json.loads(body.decode("utf-8"))
                record = add_completion(payload)
            except (ValueError, json.JSONDecodeError, OSError) as error:
                self.send_json(400, {"error": str(error) or "Could not save."})
                return
            self.send_json(201, record)
            return
        if parsed.path == "/api/workouts":
            content_type = self.headers.get("Content-Type", "")
            try:
                workout = save_upload(body, content_type)
            except (ValueError, OSError) as error:
                self.send_json(400, {"error": str(error) or "Could not save the workout."})
                return
            self.send_json(201, workout)
            return
        self.send_json(404, {"error": "Not found."})

    def route_delete(self):
        parts = [unquote(part) for part in urlparse(self.path).path.split("/") if part]
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "completions":
            result = delete_completion(parts[2])
            if result is None:
                self.send_json(404, {"error": "That entry is already gone."})
                return
            self.send_json(200, result)
            return
        self.send_json(404, {"error": "Not found."})

    def send_json(self, status: int, payload) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def send_file(self, path: Path, content_type: str) -> None:
        if not path.is_file():
            self.send_json(404, {"error": "Not found."})
            return
        raw = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt: str, *args) -> None:
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


def check() -> None:
    chin = parse_exercise(
        "01 - Chin Tuck - 2sets10reps-5s hold each rep 10s rest between sets.png",
        1,
    )
    assert chin["name"] == "Chin Tuck" and chin["sets"] == 2 and chin["reps"] == 10
    assert chin["notes"] == "5s hold each rep 10s rest between sets" and chin["qualifier"] == ""

    slides = parse_exercise("02 - Wall Slides - 2sets10reps-slow controlled.png", 2)
    assert slides["notes"] == "slow controlled" and slides["reps"] == 10

    bridge = parse_exercise("03 - Glute Bridge - 2sets12reps-2s squeeze at top.png", 3)
    assert bridge["reps"] == 12 and bridge["notes"] == "2s squeeze at top"

    bug = parse_exercise("04 - Dead bug - 2sets6reps per side - slow controlled.png", 4)
    assert bug["name"] == "Dead bug" and bug["reps"] == 6
    assert bug["qualifier"] == "per side" and bug["notes"] == "slow controlled"

    spaced = parse_exercise("5 - Bird dog - 3 sets 8 reps - slow.png", 5)
    assert spaced["sets"] == 3 and spaced["reps"] == 8 and spaced["notes"] == "slow"

    workouts = list_workouts()
    posture = next(item for item in workouts if item["id"] == "workout - posture 6w")
    assert [item["name"] for item in posture["exercises"]] == [
        "Chin Tuck",
        "Wall Slides",
        "Glute Bridge",
        "Dead bug",
    ]

    boundary = "----xtest"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="name"\r\n\r\n'
        "posture\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="files"; filename="01 - Test - 2sets10reps-slow.png"\r\n'
        "Content-Type: image/png\r\n\r\n"
    ).encode() + b"\x89PNG\r\n" + f"\r\n--{boundary}--\r\n".encode()
    uploaded = parse_multipart(body, f"multipart/form-data; boundary={boundary}")
    assert uploaded["fields"]["name"] == ["posture"]
    assert uploaded["files"][0]["data"].startswith(b"\x89PNG")


def serve(preferred: int) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        DATA_FILE.write_text("[]\n", encoding="utf-8")
    write_workouts_manifest()
    httpd = None
    port = preferred
    for port in range(preferred, preferred + 20):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            httpd = None
    if httpd is None:
        raise SystemExit(f"Could not listen on ports {preferred}-{preferred + 19}.")
    print(f"xTracker is running at http://127.0.0.1:{port}", flush=True)
    print("Workouts are read from the Images folder.", flush=True)
    print("Finished workouts are saved to data/completions.json", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()


def main() -> None:
    import sys

    if "--check" in sys.argv:
        check()
        print("ok")
        return
    port = 8765
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])
    serve(port)


if __name__ == "__main__":
    main()
