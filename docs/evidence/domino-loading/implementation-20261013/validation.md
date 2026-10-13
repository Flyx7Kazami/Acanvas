# Domino loading implementation validation

Date: 2026-10-13, Asia/Shanghai.

The delivered loader is a two-second, single-color outline loop. Three rounded cards rotate around fixed bottom edges from −8° upright to 86° fallen, with 135ms fall staggering and a smooth staggered reset. All paths have transparent interiors and inherit `currentColor`. Reduced motion uses the upright pose. Anatomy supplies `roundedPlan`, `pathOf`, `fitProjection` and `iso` at build time; typed CSS number properties interpolate the projected height-vector columns directly. The application has no JavaScript animation loop or per-frame React rendering for this mark.

## Commands and results

- `.runtime/node_modules/node/bin/node assets/brand/domino/build.mjs`: passed. Produces the portable SVG, offline preview and shared React geometry/CSS files.
- `.runtime/node_modules/node/bin/node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`: passed.
- `.runtime/node_modules/node/bin/node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit`: passed.
- `.runtime/node_modules/node/bin/node node_modules/vite/bin/vite.js build --outDir /private/tmp/acanvas-domino-loading-20261013/web`: passed. This is the normal candidate build. Checks did not write `dist` or update the running service.
- `git diff --check`: passed.
- Isolated Chrome captured actual CSS poses at 0, 350, 520, 900, 1340 and 2000ms. Computed transforms reflect the sequential fall, all three cards at 86° at 900ms, staggered reset and matching loop endpoints. [Pose data](poses.json), [six-pose sheet](poses.png).
- Actual 32px, 48px and 64px marks in light/dark, reduced motion and 390px presentation were visually inspected. All 60 export frames were inspected together. `domino.gif` is a compact 160×128, 30fps, two-second presentation; `preview.png` is a transparent 64×64 upright mark.
- Nine focused product checks passed with zero uncaught browser errors. The normal production bundle's real startup was held by a delayed state response from an isolated temporary project. It showed the 48px loader and stable product status, then removed the loader when loading completed. Reduced-motion startup stayed still. [Product results](product.json).

## Existing internal switch indicator

The current UI has no visible caller for `useBoard.switchSession`. A separate temporary fixture build exposed the actual hook return through a build-only bridge. Calling its real `switchSession` with a delayed target-session response exercised the actual App `canvas-busy` branch with the shared 32px component; it disappeared when the target state resolved. This establishes internal hook/branch behavior, rather than a visible user-control path. The bridge, fixture build and fixture scripts remain under `/private/tmp/acanvas-domino-loading-20261013` and are excluded from product source and deployment.

The fixture used only an independently created temporary project. The supplied static PNG and its product derivatives were preserved. No actual project `.acanvas` data or live service resources were written during these checks.

## Accepted web-resource update

After the independent review passed, the accepted normal build at `/private/tmp/acanvas-domino-loading-20261013/web` was installed into the existing web resource directory. Only the new normal main JS/CSS files were copied; all previous assets were retained, and `index.html` was replaced atomically. The previous index is backed up at `/private/tmp/acanvas-domino-loading-live-backup-20cOuu/index.html`.

Read-only HTTP confirmed that the served root HTML and referenced resources matched the accepted normal build, with the service's normal preview-origin metadata accounted for. Both selected PNG assets remained unchanged, and PID 56724 kept its original command. The fixture bridge was absent from the accepted main bundle. This operation performed no rebuild, service restart, API mutation or board-data write. See [update evidence](live-update.json).
