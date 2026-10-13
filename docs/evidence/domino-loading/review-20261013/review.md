# Independent loading review

2026-10-13. Result: **PASS**, with no open actionable P0–P3 findings in the reviewed loading change.

Reviewed the final `model.mjs`, `build.mjs`, generated SVG/CSS/TypeScript, `DominoLoader.tsx`, the two App loading branches, and the refreshed GIF/PNG. The current requirements are recorded in `docs/DOMINO_LOADING.md`; the new PLAN section distinguishes current loading work from the initial filled animation.

- Three rounded paths have `fill:none`, monochrome `currentColor` strokes and fixed projected bottom hinges. The model rotates cards from −8° to 86° with 135ms fall spacing within 2000ms. Typed numeric CSS properties preserve the projected path through the edge-on pose.
- Independently sampled 0, 300, 550, 850, 1250 and 1650ms poses show sequential collapse, the flat pose and staggered reset. All path bounds fit 32/48/64px SVGs in light/dark contact sheets. Computed transforms at 1999ms equal the opening pose.
- The ordinary isolated production bundle displays the real startup loader while bootstrap is held, with one stable status and three decorative paths; releasing bootstrap opens the board and removes the loader. The 390px light/dark product screenshots fit, and dark strokes resolve to RGB 243/243/243.
- The actual `useBoard.switchSession` hook and App switching branch were exercised through a fixture-only Vite bridge against an isolated service. The loader appears while the state request is held and disappears after the destination session is adopted. The current product has no user-reachable session-switch control; this verifies the hook/branch, not such a control.
- The offline HTML opens without network dependencies or playback controls. The portable SVG contains the same generated CSS as React and animates as an external image. Reduced motion removes all path animations and keeps the upright mark stable.
- The reusable SVG has transparent interiors and background. The independently rendered flat PNG has transparent corners. The delivered 64×64 PNG has 3654 fully transparent pixels out of 4096.
- The GIF is the explicitly documented light-background presentation preview: 160×128, 60 frames, exactly 2000ms, infinite Netscape loop. Independently composited GIF frames show the fall/reset, and its first/last displayed RGBA frames match byte for byte. Its background is opaque by design.

Validation commands used the project Node 24 runtime:

```sh
.runtime/node_modules/node/bin/node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
.runtime/node_modules/node/bin/node node_modules/vite/bin/vite.js build --outDir /private/tmp/acanvas-loading-review-web-20261013
.runtime/node_modules/node/bin/node node_modules/typescript/bin/tsc -p tsconfig.server.json --outDir /private/tmp/acanvas-loading-review-server-20261013
```

All passed. The last command compiled the independent temporary fixture server; it did not write live `dist`. Final isolated browser checks in `review.json` have zero browser errors. `exports.json` records refreshed export metadata. Pose sheets and product screenshots accompany this report.

The original selected PNG and its product/favicon derivatives have no Git changes in this correction. No live service restart, real-project whiteboard API writes, source edits or Git commits were performed by this reviewer. Only review evidence was added to the repository.

## Delivered-resource review

The final read-only delivery review also **PASS**es. At 2026-10-13T03:22:16Z, the served root on `127.0.0.1:4317` matched `/private/tmp/acanvas-domino-loading-20261013/web/index.html` after removing the service's single normal preview-origin metadata tag. Its two JavaScript files, two CSS files and favicon each returned HTTP 200 and matched the accepted ordinary build byte for byte. The served JavaScript excludes the temporary `__dominoFixtureBoard` bridge and this reviewer's source-fixture bridge.

PID 56724 still has the original Node service command for project acanvas, port 4317 and preview port 60186. `delivery.json` records the resource comparison, process observation and zero API/mutation requests. No build or browser application startup was performed during this delivery check.

The final `docs/DOMINO_LOADING.md`, PLAN loading section and PLAN progress row accurately mark independent acceptance and live resource delivery complete. They preserve the internal switching-fixture boundary and distinguish transparent loading assets from the light-background GIF presentation preview. The earlier 8.6-second motion remains documented as historical work.
