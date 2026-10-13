# Acanvas Domino assets

The static icon preserves the selected source composition: three rounded cards in green `#89B27A`, pink `#FA9EB3` and gray `#9F9E9E`, overlapping in that order. The SVG background is transparent. `source-icon.png` is the original reference; `icon.svg` is the vector master. Product branding and the browser icon use the corresponding SVG resources under `src/web/public/`.

`domino.svg` is the animated loading asset. Its opaque, borderless grayscale cards advance from upper right toward lower left. It uses the selected historical view from `comparison/previous.html`, preserving width/height/pitch 14/30/14, the 72×64 viewBox and camera origin [36,44], scale 1.15, azimuth −35° and elevation 28°. Cadence is 375ms per card, 20% slower than the 300ms reference; fifteen reusable slots make a 5625ms cycle.

## Build and integration

From the project root:

```sh
.runtime/node_modules/node/bin/node assets/brand/domino/build.mjs
```

The model generates the portable animation, offline preview and `src/web/domino-loader.generated.ts` / `.css`. `src/web/DominoLoader.tsx` accepts a numeric `size` and optional `className`. Loading states share this component at sizes appropriate for the board, notifications, content previews and busy buttons.

The component is decorative and carries `aria-hidden`; its surrounding state supplies the status or accessible button name. Audio waveform loading uses its horizontal line, and annotation Done keeps its text button. The grayscale palette adapts to light/dark presentation. CSS animates the projected card faces without per-frame React rendering. Reduced motion freezes the initial pose.

`model.mjs` owns the rounded face, contact relation, stationary hinges, linear camera and projection. Anatomy supplies `roundedPlan`, `pathOf` and `iso` at build time. Typed CSS numbers interpolate projected face columns and hinge translation. HTML stacking layers inside SVG `foreignObject` keep the selected card-center depth order. Each slot recycles outside the view, with consistent palette repetition.

`domino.gif` and `preview.png` are rendered exports of the loading scene. Historical candidates and their evidence remain under `comparison/` and `docs/evidence/`. Current scope, validation and installed-resource status are in [Domino SVG and unified loading](../../../docs/DOMINO_UNIFIED.md).

## Anatomy source

`vendor/anatomy/iso-kit.mjs` and its [MIT license](vendor/anatomy/LICENSE) come from [Anatomy](https://github.com/wheresryan22/anatomy). The portable animation includes the license notice.
