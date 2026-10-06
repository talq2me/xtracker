const app = document.querySelector("#app");
const live = document.querySelector("#live");
const sessionKey = "xtracker-step";
const lastKey = "xtracker-last";

const state = {
  workouts: [],
  completions: [],
  ready: false,
  loadError: "",
  error: "",
  saving: false,
  step: 0,
  month: startOfMonth(new Date()),
  selectedDay: "",
  confirmRemove: "",
};

let activeSession = "";
let scrollKey = "";

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function todayISO() {
  const now = new Date();
  return isoDate(now.getFullYear(), now.getMonth(), now.getDate());
}

function isoDate(year, monthIndex, day) {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isoMonth(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function parseISODate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDay(value) {
  return parseISODate(value).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatShort(value) {
  return parseISODate(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseRoute() {
  const parts = (location.hash || "#/").replace(/^#\/?/, "").split("/").filter(Boolean);
  const head = parts[0] ? decodePart(parts[0]) : "home";
  const arg = parts[1] ? decodePart(parts.slice(1).join("/")) : "";
  if (head === "calendar") return { name: "calendar" };
  if (head === "new") return { name: "new" };
  if (head === "done") return { name: "done" };
  if (head === "workout") return { name: "detail", workout: arg };
  if (head === "session") return { name: "session", workout: arg };
  return { name: "home" };
}

function findWorkout(id) {
  return state.workouts.find((workout) => workout.id === id) || null;
}

async function getJSON(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

function imageUrl(workout, file) {
  return `/media/${encodeURIComponent(workout)}/${encodeURIComponent(file)}`;
}

function buildSteps(exercises) {
  const maxSets = Math.max(1, ...exercises.map((exercise) => exercise.sets || 1));
  const steps = [];
  for (let setNumber = 1; setNumber <= maxSets; setNumber += 1) {
    const round = exercises.filter((exercise) => (exercise.sets || 1) >= setNumber);
    round.forEach((exercise, index) => {
      steps.push({
        exercise,
        setNumber,
        setTotal: exercise.sets || 1,
        indexInRound: index,
        roundSize: round.length,
      });
    });
  }
  return steps;
}

function sameSetCount(exercises) {
  return new Set(exercises.map((exercise) => exercise.sets)).size <= 1;
}

function prescription(exercise) {
  if (exercise.unparsed || exercise.reps == null) {
    return "Sets and reps are not in the file name";
  }
  const sets = plural(exercise.sets, "set");
  const unit = exercise.qualifier ? `reps ${exercise.qualifier}` : "reps";
  return `${sets} · ${exercise.reps} ${unit}`;
}

function repsUnit(exercise) {
  return exercise.qualifier ? `reps ${exercise.qualifier}` : "reps";
}

function cardMeta(exercises) {
  const label = plural(exercises.length, "exercise");
  if (!exercises.length || !sameSetCount(exercises)) return label;
  return `${label} · ${plural(exercises[0].sets, "set")}`;
}

function detailSummary(exercises) {
  const label = plural(exercises.length, "exercise");
  if (!exercises.length) return "No exercise images in this folder yet.";
  if (!sameSetCount(exercises)) {
    return `${label}. You go through the list once per set. Exercises with fewer sets drop out of later rounds.`;
  }
  if (exercises[0].sets === 1) return `${label} · 1 set.`;
  return `${label} · ${plural(exercises[0].sets, "set")}. You go through the full list for each set.`;
}

function lastCompletion(workoutId) {
  return state.completions
    .filter((item) => item.workout === workoutId)
    .sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1))[0] || null;
}

function monthCount(date) {
  const prefix = isoMonth(date);
  return state.completions.filter((item) => (item.completedOn || "").startsWith(prefix)).length;
}

function readStep(workoutId) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(sessionKey) || "null");
    if (saved && saved.workout === workoutId && Number.isInteger(saved.step)) return saved.step;
  } catch {
    /* ignore broken session storage */
  }
  return 0;
}

function saveStep(workoutId, step) {
  sessionStorage.setItem(sessionKey, JSON.stringify({ workout: workoutId, step }));
}

function clearSession() {
  activeSession = "";
  state.step = 0;
  sessionStorage.removeItem(sessionKey);
}

function announce(message) {
  live.textContent = message;
}

function preload(workout) {
  workout.exercises.forEach((exercise) => {
    const image = new Image();
    image.src = imageUrl(workout.id, exercise.file);
  });
}

function render() {
  const route = parseRoute();
  document.title = titleFor(route);
  app.className = route.name;
  app.innerHTML = view(route);
  if (route.name !== "session" && route.name !== "done") announce("");
  const key = `${route.name}:${route.workout || ""}:${state.step}:${state.month.getFullYear()}-${state.month.getMonth()}`;
  if (key !== scrollKey) {
    scrollKey = key;
    window.scrollTo(0, 0);
  }
}

function titleFor(route) {
  if (route.name === "calendar") return "Calendar · xTracker";
  if (route.name === "new") return "Add a workout · xTracker";
  if (route.name === "done") return "Workout saved · xTracker";
  if (route.name === "detail" || route.name === "session") {
    return `${route.workout || "Workout"} · xTracker`;
  }
  return "xTracker";
}

function view(route) {
  if (!state.ready) return `<p class="lede">Loading workouts…</p>`;
  if (state.loadError && !state.workouts.length && route.name !== "calendar") {
    return `<h1>xTracker</h1><p class="banner">${esc(state.loadError)}</p>`;
  }
  if (route.name === "calendar") return renderCalendar();
  if (route.name === "new") return renderNew();
  if (route.name === "done") return renderDone();
  if (route.name === "detail") return renderDetail(route.workout);
  if (route.name === "session") return renderSession(route.workout);
  return renderHome();
}

function renderHome() {
  const count = monthCount(new Date());
  const logged = count
    ? `${plural(count, "workout")} logged this month`
    : "Nothing logged this month";
  const cards = state.workouts.map((workout) => {
    const last = lastCompletion(workout.id);
    const when = last
      ? `<p class="when done">Last done ${esc(formatShort(last.completedOn))}</p>`
      : `<p class="when">Not logged yet</p>`;
    const names = workout.exercises.map((exercise) => exercise.name).join(" · ");
    return `<a class="workout-card" href="#/workout/${encodeURIComponent(workout.id)}">
      <h2>${esc(workout.id)}</h2>
      <p class="meta">${esc(cardMeta(workout.exercises))}</p>
      ${names ? `<p class="names">${esc(names)}</p>` : ""}
      ${when}
    </a>`;
  }).join("");
  const empty = state.workouts.length
    ? ""
    : `<div class="empty">
        <h2>No workouts yet</h2>
        <p class="hint">Add a folder of exercise images, or copy one into the Images directory.</p>
      </div>`;
  return `<header class="top">
      <h1>xTracker</h1>
      <a class="button ghost" href="#/calendar">Calendar</a>
    </header>
    <p class="lede">${esc(logged)}</p>
    <div class="workout-list">${cards}</div>
    ${empty}
    <p class="add-row"><a href="#/new">Add a workout</a></p>`;
}

function renderDetail(workoutId) {
  const workout = findWorkout(workoutId);
  if (!workout) return missing();
  preload(workout);
  const items = workout.exercises.map((exercise) => `<li class="exercise">
      <span class="ord">${esc(String(exercise.order).padStart(2, "0"))}</span>
      <div>
        <h2>${esc(exercise.name)}</h2>
        <p class="rx">${esc(prescription(exercise))}</p>
        ${exercise.notes ? `<p class="cue-small">${esc(exercise.notes)}</p>` : ""}
      </div>
    </li>`).join("");
  const start = workout.exercises.length
    ? `<div class="dock"><div class="dock-inner">
        <button type="button" class="button" data-action="start" data-workout="${esc(workout.id)}">Start workout</button>
      </div></div>`
    : "";
  return `<a class="back" href="#/">← Workouts</a>
    <h1>${esc(workout.id)}</h1>
    <p class="lede">${esc(detailSummary(workout.exercises))}</p>
    <ol class="exercises">${items}</ol>
    ${start}`;
}

function renderSession(workoutId) {
  const workout = findWorkout(workoutId);
  if (!workout) {
    announce("");
    return missing();
  }
  if (!workout.exercises.length) {
    return `<a class="back" href="#/workout/${encodeURIComponent(workout.id)}">← Exercises</a>
      <h1>${esc(workout.id)}</h1>
      <p class="lede">This workout has no exercises yet.</p>`;
  }
  if (activeSession !== workout.id) {
    activeSession = workout.id;
    state.step = readStep(workout.id);
  }
  const steps = buildSteps(workout.exercises);
  if (state.step > steps.length - 1) state.step = steps.length - 1;
  if (state.step < 0) state.step = 0;
  saveStep(workout.id, state.step);
  preload(workout);
  const current = steps[state.step];
  const exercise = current.exercise;
  const next = steps[state.step + 1];
  let label = "Finish workout";
  if (next && next.setNumber !== current.setNumber) label = `Start set ${next.setNumber}`;
  else if (next) label = "Next exercise";
  const percent = Math.round(((state.step + 1) / steps.length) * 100);
  const reps = exercise.reps == null
    ? `<p class="cue">Reps are not in the file name.</p>`
    : `<p class="reps-num">${esc(exercise.reps)}</p><p class="reps-label">${esc(repsUnit(exercise))}</p>`;
  const cue = exercise.notes ? `<p class="cue">${esc(exercise.notes)}</p>` : "";
  const error = state.error ? `<p class="banner">${esc(state.error)}</p>` : "";
  announce(`${exercise.name}. ${exercise.reps == null ? "" : `${exercise.reps} ${repsUnit(exercise)}.`} Set ${current.setNumber} of ${current.setTotal}.`);
  return `<div class="progress" aria-hidden="true"><span style="width:${percent}%"></span></div>
    <header class="session-top">
      <a class="back" href="#/workout/${encodeURIComponent(workout.id)}" data-action="exit">Exit</a>
      <p class="pill">Set ${current.setNumber} of ${current.setTotal}</p>
    </header>
    <p class="kicker">Exercise ${current.indexInRound + 1} of ${current.roundSize}</p>
    <h1>${esc(exercise.name)}</h1>
    <div class="sheet-frame">
      <img src="${imageUrl(workout.id, exercise.file)}" alt="${esc(exercise.name)}">
    </div>
    ${reps}
    ${cue}
    <div class="dock"><div class="dock-inner">
      ${error}
      <button type="button" class="button" data-action="advance" ${state.saving ? "disabled" : ""}>
        ${state.saving ? "Saving…" : esc(label)}
      </button>
    </div></div>`;
}

function renderDone() {
  const workoutId = sessionStorage.getItem(lastKey) || "";
  const workout = findWorkout(workoutId);
  const last = lastCompletion(workoutId);
  const when = last ? `${formatDay(last.completedOn)} at ${formatTime(last.completedAt)}` : "today";
  announce(workout ? `${workout.id} saved` : "Workout saved");
  const push = readPushResult();
  const pushNote = push.pushed
    ? `<p class="lede">Saved to GitHub.</p>`
    : `<p class="banner">${esc(push.pushError || "Saved on this computer. GitHub push failed.")}</p>`;
  return `<a class="back" href="#/">← Workouts</a>
    <h1>Workout complete</h1>
    <p class="lede">${esc(workout ? workout.id : "This workout")} is on the calendar for ${esc(when)}.</p>
    ${push.known ? pushNote : ""}
    <div class="stack">
      <a class="button" href="#/calendar">Calendar</a>
      <a class="button ghost" href="#/">All workouts</a>
    </div>`;
}

function renderNew() {
  const error = state.error ? `<p class="banner">${esc(state.error)}</p>` : "";
  return `<a class="back" href="#/">← Workouts</a>
    <h1>Add a workout</h1>
    <p class="lede">The folder name becomes the workout name. Sets, reps, and cues come from each image name.</p>
    <form class="form" id="add-form">
      ${error}
      <label>Workout name
        <input name="name" type="text" required maxlength="80" placeholder="workout - posture 6w" autofocus>
      </label>
      <label>Exercise images
        <input name="files" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple required>
      </label>
      <p class="hint">Name the files in order, for example <code>01 - Chin Tuck - 2sets10reps-5s hold each rep.png</code> or <code>04 - Dead bug - 2sets6reps per side - slow controlled.png</code>. You can also copy a folder into Images.</p>
      <button class="button" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save workout"}</button>
    </form>`;
}

function renderCalendar() {
  if (!state.selectedDay && state.month.getFullYear() === new Date().getFullYear() && state.month.getMonth() === new Date().getMonth()) {
    state.selectedDay = todayISO();
  }
  const year = state.month.getFullYear();
  const month = state.month.getMonth();
  const title = state.month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const count = monthCount(state.month);
  const summary = count ? `${plural(count, "workout")} in ${state.month.toLocaleDateString(undefined, { month: "long" })}` : `No workouts in ${state.month.toLocaleDateString(undefined, { month: "long" })}`;
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let index = 0; index < firstWeekday; index += 1) cells.push('<span class="day blank"></span>');
  const byDay = new Map();
  state.completions.forEach((item) => {
    if (!byDay.has(item.completedOn)) byDay.set(item.completedOn, []);
    byDay.get(item.completedOn).push(item);
  });
  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = isoDate(year, month, day);
    const logged = byDay.get(iso) || [];
    const classes = ["day"];
    if (logged.length) classes.push("has");
    if (iso === todayISO()) classes.push("today");
    if (iso === state.selectedDay) classes.push("selected");
    const accessible = logged.length
      ? `${formatDay(iso)}, ${plural(logged.length, "workout")}`
      : formatDay(iso);
    cells.push(`<button type="button" class="${classes.join(" ")}" data-action="select-day" data-day="${iso}" aria-label="${esc(accessible)}" aria-pressed="${iso === state.selectedDay ? "true" : "false"}"${iso === todayISO() ? ' aria-current="date"' : ""}>${day}</button>`);
  }
  const selected = byDay.get(state.selectedDay) || [];
  const panel = state.selectedDay ? `<section class="panel">
      <h2>${esc(formatDay(state.selectedDay))}</h2>
      ${selected.length ? `<ul class="log-list">${selected.map((item) => `<li>
          <div>
            <strong>${esc(item.workout)}</strong>
            <p>${esc(formatTime(item.completedAt))}</p>
          </div>
          <button type="button" class="remove" data-action="remove" data-id="${esc(item.id)}">${state.confirmRemove === item.id ? "Confirm remove" : "Remove"}</button>
        </li>`).join("")}</ul>` : `<p class="hint">Nothing logged this day.</p>`}
    </section>` : "";
  const error = state.error ? `<p class="banner">${esc(state.error)}</p>` : "";
  return `<a class="back" href="#/">← Workouts</a>
    ${error}
    <div class="cal-nav">
      <button type="button" class="icon-button" data-action="prev-month" aria-label="Previous month">‹</button>
      <h1>${esc(title)}</h1>
      <button type="button" class="icon-button" data-action="next-month" aria-label="Next month">›</button>
    </div>
    <p class="lede">${esc(summary)}</p>
    <div class="weekdays"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
    <div class="grid">${cells.join("")}</div>
    ${panel}
    <p class="footnote">Finished workouts are written to <code>data/completions.json</code> and pushed to GitHub.</p>`;
}

function missing() {
  return `<a class="back" href="#/">← Workouts</a>
    <h1>Workout not found</h1>
    <p class="lede">That folder is not in Images.</p>`;
}

async function refreshForRoute(route) {
  if (["home", "detail", "session", "done", "new"].includes(route.name)) {
    state.workouts = await getJSON("/api/workouts");
  }
  if (["home", "calendar", "done", "detail"].includes(route.name)) {
    state.completions = await getJSON("/api/completions");
  }
}

async function loadAll() {
  try {
    await refreshForRoute(parseRoute());
    state.loadError = "";
  } catch {
    state.loadError = "Could not load workouts. Start the app with python server.py and refresh.";
  }
  state.ready = true;
  render();
}

async function onRoute() {
  const route = parseRoute();
  try {
    await refreshForRoute(route);
    state.loadError = "";
  } catch {
    state.loadError = "Could not reach the server.";
  }
  state.ready = true;
  render();
}

async function finish(workoutId) {
  if (state.saving) return;
  state.saving = true;
  state.error = "";
  render();
  try {
    const saved = await getJSON("/api/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workout: workoutId,
        completedAt: new Date().toISOString(),
        completedOn: todayISO(),
      }),
    });
    sessionStorage.setItem("xtracker-push", JSON.stringify({
      pushed: Boolean(saved.pushed),
      pushError: saved.pushError || "",
    }));
    clearSession();
    sessionStorage.setItem(lastKey, workoutId);
    state.saving = false;
    location.hash = "#/done";
    if (parseRoute().name === "done") await onRoute();
  } catch (error) {
    state.saving = false;
    state.error = error.message || "Could not save this workout.";
    render();
  }
}

async function removeCompletion(id) {
  if (state.confirmRemove !== id) {
    state.confirmRemove = id;
    render();
    return;
  }
  state.confirmRemove = "";
  const result = await getJSON(`/api/completions/${encodeURIComponent(id)}`, { method: "DELETE" });
  state.error = result.pushed ? "" : (result.pushError || "Removed on this computer. GitHub push failed.");
  state.completions = await getJSON("/api/completions");
  render();
}

function readPushResult() {
  try {
    const saved = JSON.parse(sessionStorage.getItem("xtracker-push") || "null");
    if (saved && typeof saved.pushed === "boolean") return { known: true, pushed: saved.pushed, pushError: saved.pushError || "" };
  } catch {
    /* ignore broken session storage */
  }
  return { known: false, pushed: false, pushError: "" };
}

app.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === "exit") {
    clearSession();
    announce("");
    return;
  }
  if (action === "start") {
    event.preventDefault();
    const workoutId = button.dataset.workout;
    activeSession = workoutId;
    state.step = 0;
    state.error = "";
    saveStep(workoutId, 0);
    location.hash = `#/session/${encodeURIComponent(workoutId)}`;
    return;
  }
  if (action === "advance") {
    const route = parseRoute();
    const workout = findWorkout(route.workout);
    if (!workout) return;
    const steps = buildSteps(workout.exercises);
    if (state.step >= steps.length - 1) {
      void finish(workout.id);
      return;
    }
    state.step += 1;
    state.error = "";
    saveStep(workout.id, state.step);
    render();
    return;
  }
  if (action === "prev-month" || action === "next-month") {
    const delta = action === "next-month" ? 1 : -1;
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + delta, 1);
    state.selectedDay = "";
    state.confirmRemove = "";
    render();
    return;
  }
  if (action === "select-day") {
    state.selectedDay = button.dataset.day;
    state.confirmRemove = "";
    render();
    return;
  }
  if (action === "remove") {
    void removeCompletion(button.dataset.id).catch((error) => {
      state.error = error.message || "Could not remove that entry.";
      render();
    });
  }
});

app.addEventListener("submit", (event) => {
  const form = event.target;
  if (form.id !== "add-form") return;
  event.preventDefault();
  void saveWorkout(form);
});

document.addEventListener("keydown", (event) => {
  if (event.repeat || event.key !== "ArrowRight") return;
  if (event.target.closest("input, textarea")) return;
  if (parseRoute().name !== "session") return;
  const button = app.querySelector("[data-action='advance']");
  if (button && !button.disabled) button.click();
});

async function saveWorkout(form) {
  if (state.saving) return;
  const data = new FormData(form);
  state.saving = true;
  state.error = "";
  render();
  try {
    const workout = await getJSON("/api/workouts", { method: "POST", body: data });
    state.saving = false;
    location.hash = `#/workout/${encodeURIComponent(workout.id)}`;
  } catch (error) {
    state.saving = false;
    state.error = error.message || "Could not save the workout.";
    render();
  }
}

window.addEventListener("hashchange", () => {
  void onRoute();
});

loadAll();
