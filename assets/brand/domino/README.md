# acanvas · Domino

Open `index.html` directly in a browser. It includes its styles, geometry, runtime and license, and works offline.

The resting composition follows the selected `Layered Pastel Cards.png`. `source-icon.png` preserves the original image. The product uses 128px and 64px PNG derivatives at `src/web/public/brand/acanvas-icon.png` and `acanvas-favicon.png`; the animation is an editable vector interpretation.

## Build

From the project root:

```sh
.runtime/node_modules/node/bin/node assets/brand/domino/build.mjs
```

`model.mjs` owns the three colors, calibrated card outlines and shared 8.6 second timeline. The cards unfold in sage → blush → stone order and settle into the icon. `live.mjs` drives the SVG and controls from that timeline. `style.css` supplies the light, dark and responsive presentation.

Play/pause, replay and the timeline work with pointer input. Focus the figure to use Space or Enter for playback, arrows to step 0.1 seconds, Shift+arrows to step 0.5 seconds, Home/End for timeline bounds, R for replay and Escape for pause. Focusing the timeline pauses playback for inspection. Native button keyboard activation is preserved.

Reduced motion starts at the composed pose and keeps playback still; the timeline and stepping controls support direct inspection. Playback suspends when the stage is offscreen or the document is hidden, then resumes from its existing time when visible. Explicitly paused playback stays paused.

## Anatomy source

The vendored `iso-kit.mjs` and its MIT license come from [Anatomy](https://github.com/wheresryan22/anatomy). The model uses `cameraOf`, `roundedPlan` and `extrude` for the projected rounded solids, and `solidSvg`/`figureSvg` for markup. Card faces retain the selected palette, with shallow shaded edges and soft contact shadows. The generated HTML includes the same kit and license.

The three card planes remain separated in depth throughout the motion. Their layer order stays sage, blush, stone. All motion and readouts come from `dominoAt()`; the quintic easing has zero velocity at each held pose.
