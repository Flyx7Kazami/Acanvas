# acanvas domino loader

`domino.svg` is a transparent, monochrome loading animation. Its three rounded outlines fall sequentially to 86° around fixed bottom edges, rest briefly, then rise in a staggered reset. The loop lasts two seconds. Inline the SVG to inherit the surrounding `currentColor`.

Open `index.html` directly to preview the small loading mark offline. It follows the system light/dark theme. Reduced motion shows the upright outlines.

## Build and integration

From the project root:

```sh
.runtime/node_modules/node/bin/node assets/brand/domino/build.mjs
```

The build writes the portable SVG, standalone preview, `src/web/domino-loader.generated.ts` and `src/web/domino-loader.generated.css` from the same geometry and timeline. `src/web/DominoLoader.tsx` renders those generated paths and accepts a numeric `size` (default 48) and optional `className`.

The component is decorative and carries `aria-hidden`; its surrounding loading state supplies one stable `role="status"` and normal loading copy. The application uses it for opening a board and the existing internal board-switch indicator. Unrelated compact progress controls retain their existing behavior.

`model.mjs` owns the card dimensions, camera, bottom-edge hinges and timing. It uses Anatomy's `roundedPlan`, `pathOf`, `fitProjection` and `iso` at build time. The rendered face is a pure stroked outline with transparent interior. Typed CSS number properties interpolate the two projected height-vector columns directly, including the edge-on part of the fall. Playback runs through CSS without a JavaScript animation loop or per-frame React rendering. The SVG stylesheet uses CDATA so the typed property syntax remains valid in both standalone SVG and embedded HTML.

`domino.gif` and `preview.png` are presentation exports of this same loader. The PNG has a transparent background. `source-icon.png` remains the original user-selected static image; product branding uses the existing resized PNG derivatives.

## Anatomy source

`vendor/anatomy/iso-kit.mjs` and its [MIT license](vendor/anatomy/LICENSE) come from [Anatomy](https://github.com/wheresryan22/anatomy). The portable SVG includes the license notice. The user's pure-outline loading direction determines the rendering style.
