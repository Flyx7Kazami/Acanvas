# Independent Domino review

Date: 2026-10-13. Result: PASS for the final source and isolated artifacts, with the native visibility boundary below. No open actionable P0–P3 findings.

Scope: selected source image and resized product PNGs; `src/web/index.html`; the brand locations in `App.tsx` and brand CSS; `assets/brand/domino/`. Existing host-delivery changes were excluded. Review changed no implementation source files or user board data and performed no service restart. The initial default build wrote generated artifacts under `dist/`, as detailed below.

## Verification

- The selected download and `source-icon.png` are byte-identical (1,426,219 bytes). Product image is 128×128/14,796 bytes; favicon is 64×64/4,259 bytes. The standalone embeds exactly the same 64px PNG bytes.
- Final standalone loaded by `file://` with the browser offline. One local HTML request, zero external requests and zero JavaScript errors; three cards rendered. Anatomy kit and MIT license match the installed skill sources.
- Real Chrome pointer and keyboard input passed play/pause, replay, native button activation, Space/Enter, arrows, Shift+arrows, Home/End, R, Escape and pointer scrub. Timeline focus pauses at its current time and exposes matching accessible value text.
- 87 samples covering the full 8.6-second timeline stayed inside the 760×540 stage: x=164…612.5, y=23.6…501.8. Source uses continuous quintic easing and returns to the composed pose.
- Desktop and 390px screenshots in light/dark were inspected. Rounded sage→pink→gray composition remains recognizable; controls fit without horizontal overflow. Reduced motion started at time zero with playback still, and direct timeline/keyboard inspection worked.
- Actual offscreen stage movement suspended playback through IntersectionObserver at time 100ms; restoring the stage resumed from that time.
- Production bundle with isolated in-memory mock API rendered the image successfully in startup and project identity at 390/1280px light/dark. Identity icon is 22.09px and its natural image size is 128×128. Product favicon returned HTTP 200/image/png. Fixture capture-service error toast is outside this identity-only check.
- Node 24 project typecheck passed. The initial full project build passed using the default output directory; after final brand adjustments, typecheck and an independent Vite production build with an explicit isolated output directory passed. Relevant tracked diff whitespace check passed.

## Build commands and delivery boundary

The reviewer initially ran `.runtime/node_modules/node/bin/node scripts/runtime.mjs build` from the repository root. This default command compiled server/tests into `dist/` and replaced `dist/web`; it completed at approximately 04:30 local time. The live process serves web resources from that directory, so this command changed the resources available to later requests before the intended accepted web-only update. It did not restart the service process or write `.acanvas` data. This was a review isolation error and was reported immediately when the main agent asked to clarify the output boundary.

The reviewer also ran `.runtime/node_modules/node/bin/node scripts/runtime.mjs typecheck` before and after the brand adjustment. This wrapper emits server/test files into `dist/` before its frontend no-emit check. It does not replace `dist/web`.

The final independently built web artifact used `.runtime/node_modules/node/bin/node node_modules/vite/bin/vite.js build --outDir /private/tmp/acanvas-domino-review-web-20261013`. The product identity browser fixture served this explicit isolated directory. The reviewer performed no rollback or further change to generated live resources after discovering the boundary error, preserving the main agent's subsequent controlled update.

## Native document visibility boundary

This environment kept `document.hidden=false` and `visibilityState=visible` after headless tab activation, headed tab activation and window minimization. Native hidden-document suspension could therefore not be exercised here. These observations are explicitly unsupported native acceptance, not passing hidden-document tests.

A separately labelled synthetic check overrode `document.hidden` and dispatched `visibilitychange`: the existing handler stopped requestAnimationFrame at 83.3ms, held that time, and resumed to 233.3ms when visibility was restored. Code inspection confirms both `document.hidden` and the actual IntersectionObserver state control running playback. See `report.json` for the distinct records.

## Resolved during review

- SVG sizing now targets Anatomy's `.iso-svg` output.
- Timeline accessible text now follows the animation state and focus pauses inspection.
- Standalone favicon now embeds the selected PNG derivative.

Evidence: `report.json`, `assets-report.json`, `product-report.json`, and the adjacent desktop/phone/startup screenshots. The native visibility probes used temporary isolated Chrome profiles; all review browsers and the fixture server were closed. No commit was created.

The final `docs/DOMINO_ICON_MOTION.md` and new Domino section of `docs/PLAN.md` were checked against source and independent evidence. Asset paths, sizes, timeline, passed checks and native visibility limitations are accurate. Export and live-resource work remains marked in progress until the main agent records its actual completion.

## Final delivery closure

The GIF export independently passes: 500×356, 172 frames, uniform 50ms delay, total duration 8.6 seconds, infinite loop. Eight sampled poses were visually inspected in `gif-contact-sheet.png`; the first and last decoded frames are pixel-identical. `preview.png` is 880×717 and shows the composed figure and usable control layout. Details are in `gif-report.json`.

After the implementer's controlled web-only update, read-only HTTP verification against `/private/tmp/acanvas-domino-verification-20261013/final-web` passed for both PNGs and every JS/CSS resource referenced by the entry point. Each returned 200 with exact final-build bytes. The on-disk `dist/web/index.html` matches the accepted entry point; the HTTP HTML matches after the one normal `acanvas-html-preview-origin` meta element inserted by `src/server/http.ts` is removed. `live-static-report.json` records these distinct comparisons. A separate read-only process check confirmed PID 56724, start time 03:15:44 on 2026-10-13, still running.

The final Domino document and PLAN status were reviewed again: source/export/delivery completion, evidence links, the initial default-build effect and native visibility limitations accurately describe the work. The backup explicitly covers the already review-built entry point rather than claiming to preserve a pristine pre-task entry point. Final source, artifact and delivered static-resource review: PASS, with the documented native visibility boundary and review isolation error retained in the record. No further build or board/API mutation was performed for this closure.
