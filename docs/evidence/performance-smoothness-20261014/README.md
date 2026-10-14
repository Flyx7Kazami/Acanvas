# Canvas and folder measurements

The scripts use Node 24, the worktree's production build, isolated temporary projects, and a new system Chrome headless profile. The running user board is outside the measurement scope.

## Fixed fixture and input

`scripts/measure-canvas-smoothness.mjs` creates objects sequentially with fixed IDs (`perf-object-00`, etc.), separates creation timestamps, and asserts their order and initial geometry. Warm-up, measured drag, and cancellation all address `perf-object-00`: `Image 0.svg` at `(70,100)`, size `250×160`. Each result includes every fixture asset name, initial position, target ID and object order. The image/video scenes, viewport, DPR, annotation positions, and input sequence are the same in each comparison.

`scripts/measure-folder-smoothness.mjs` likewise creates fixed members and neighbors sequentially, asserts their initial order and geometry, and addresses explicit IDs for every group or object action. It captures an actual comment through Mark/Done before timing. Every operation checks the captured annotation's original target, immutable scene source and capture, current member/neighbor layout, and note content. Undo/Redo and reload verify the resulting state. Folder, secondary-board and ungrouped screenshots accompany each run.

Run a baseline or candidate round with the same command and only change `PERF_WEB_ROOT` and `PERF_OUTPUT`:

```sh
PERF_WEB_ROOT=/path/to/saved/dist/web PERF_OUTPUT=/private/tmp/canvas-round .runtime/node_modules/node/bin/node scripts/measure-canvas-smoothness.mjs
PERF_WEB_ROOT=/path/to/saved/dist/web PERF_OUTPUT=/private/tmp/folder-round .runtime/node_modules/node/bin/node scripts/measure-folder-smoothness.mjs
```

The canvas harness records input accounting, exact final DOM geometry, persistence, cancellation and reload. The folder harness records first DOM feedback and the naturally completed interactive terminal state. Its animation preference remains `no-preference`: the product's 420ms motion and 620ms transition cleanup are included rather than shortened. Script/layout duration and RAF gaps distinguish CPU work from animation wall time. Both latency measurements end at RAF observation of DOM state and exclude compositor presentation delay. Screenshots and source/state checks run outside the timed phases.

Activity-video phases assert playback readiness and an increasing cumulative video frame count. Long tasks are assigned using their start timestamps. Folder drag starts response timing at pointerdown and also reports time from the first move crossing the original 3px drag threshold. Its complete event sequence and final DOM/API poses are retained; intermediate moves are not individually claimed as presented.

`summary.json` and `folder-summary.json` contain the fixed four-round comparisons, including every measured regression. The folder source sidecars independently read the final persisted annotation and its screenshot through `CanvasService` after each temporary service closed; the harness's per-step equality checks retain the original target, complete scene source and capture. Optional `PERF_ANNOTATIONS=15 PERF_MEDIA=0 PERF_TRACE=1` creates a separate diagnostic scene with Chrome trace and CPU profile. Diagnostic timing is excluded from untraced comparisons.

`focused-summary.json` retains four additional untraced 15-annotation runs. `diagnostic-summary.json` maps two separately recorded CPU profiles to exact source using private hidden-sourcemap builds whose JavaScript matches the served builds byte for byte. The inert helper was restored from an equivalent local-constant spelling to the expression already present in the measured build before these focused runs; its modification timestamp is recorded in `focused-summary.json`.

The raw CPU profiles contain negative `timeDeltas` (baseline: 672 entries totaling −547,406µs; candidate: 578 totaling −506,584µs). The diagnostic analyzer reconstructs cumulative timestamps, sorts samples chronologically, assigns each sample its preceding adjacent interval, and clips intervals to each phase. The corrected interval values are approximate sampling estimates. The primary hotspot evidence uses unweighted sample counts with an explicit denominator of samples mapped to `src/web`; idle, program and GC samples are reported separately. Original profiles and correction totals remain available. Neither later profiling nor the focused repeats establish the exact cause of the original 52ms task, whose call stack was not recorded.

## Exploratory records

`baseline-r1/r2/r3.json.gz`, `candidate-r1/r2.json.gz`, and `exploratory-summary.json` preserve earlier diagnostic runs. Their `.board-object.first()` target depended on random IDs when a batch shared its creation timestamp; the four rounds therefore dragged different grid positions and encountered different controls/annotation obstacles. They do not establish a fixed-fixture performance comparison. The corrected scripts use the explicit targets and order described above; final records carry `fixed` in their names.

The original point-annotation fixture omitted `captureState`; the service rejected zero dimensions. The corrected fixture supplies the normal incomplete capture state. Earlier contextual-control test fixtures changed an obstacle's height while the action bar already occupied the upper clear space; the final resize fixture also moves the obstacle's upper edge and confirms a required placement change. These fixture failures are retained as explanatory notes; `contextual-controls.tap` records the passing final test.

The first folder driver calibration timed out after a correctly persisted internal move because CSS serialized `313.333333…px` as `313.333px`. DOM pose comparison now allows 0.01 world pixel, while service Undo/Redo shapes remain exact; `folder-driver-calibration-failed.json.gz` retains that fixture run. Cross-round state comparison removes independent random immutable asset IDs, compares source names/content and member/group identities, and uses six decimal places for world coordinates.
