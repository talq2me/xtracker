# xTracker

A small workout app. Each folder in `Images` is a workout. Each image is an exercise. The file name holds the order, sets, reps, and any extra cue.

## Open it

On your phone, open https://talq2me.github.io/xtracker/

The first time, choose **Connect this phone** and paste a GitHub token that can edit this repo. Finished workouts are then saved from the phone. The token stays in that browser.

On this computer you can still run:

```bash
python server.py
```

and open http://127.0.0.1:8765.

## Add a workout

Use **Add a workout** in the app, or copy a folder into `Images`.

Name each image like this:

```text
01 - Chin Tuck - 2sets10reps-5s hold each rep 10s rest between sets.png
04 - Dead bug - 2sets6reps per side - slow controlled.png
```

- `01` is the order
- then the exercise name
- then sets and reps, such as `2sets10reps` or `2sets6reps per side`
- then an optional cue after a hyphen, such as `slow controlled`

Separate those pieces with ` - `.

## Log

Finishing a workout appends a record to `data/completions.json`, then commits and pushes that file to GitHub. The calendar reads the same file. You do not need to commit it by hand.

`completedOn` is your local date. `completedAt` is the exact time.
