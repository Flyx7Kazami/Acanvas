# Domino icon and initial motion

Date: 2026-10-13 (Asia/Shanghai).

Current identity and loading selection: [Domino SVG and unified loading](DOMINO_UNIFIED.md). The selected green/pink/gray mark is redrawn as SVG, and loading uses the upper-right-to-lower-left grayscale sequence at 375ms per card. This document records the supplied PNG and initial 8.6-second motion as historical evidence.

## Scope

The selected Acanvas icon is the user-provided `Layered Pastel Cards.png`: three overlapping rounded cards in sage, pink and gray on its original light background. This selection supersedes the earlier exploratory icon directions. Preserve the supplied image as the product asset.

Use the installed [Anatomy skill](https://github.com/wheresryan22/anatomy) to create an interactive animation based on these three cards. The identity remains a simple card composition. The skill's projection, volume, motion and visual verification guidance apply to this mark; machinery and decorative components would change the requested subject.

## Product behavior

- Show appropriately sized exports of the selected PNG in the browser icon and the existing Acanvas identity locations, alongside the current wordmark. Preserve the untouched master with the source assets.
- Deliver a standalone, offline-capable HTML animation with editable source. Keep the sage → pink → gray order and the rounded card silhouette.
- A calm staggered sequence separates or leans the three cards, cascades their motion, and returns them to the composed mark. Hold the composed pose long enough to recognize the icon.
- Provide pointer and keyboard playback controls, replay and timeline inspection. Playback pauses while the document or figure is hidden. Reduced motion opens in a still pose and supports direct inspection without automatic motion.
- Support a 390px viewport and both light and dark presentation.

## Implementation and ownership

Technical execution and focused browser validation are delegated. An independent reviewer receives the requirements, acceptance criteria and final changed files. The main agent owns this document, final review coordination, progress reporting and any accepted Git commit.

The existing worktree includes unrelated host-message delivery changes. Apply the identity updates surgically and preserve those changes. Use an isolated browser preview; validation does not write user whiteboard data or restart the live service.

## Acceptance

1. The preserved master matches the supplied PNG byte for byte; web-sized derivatives retain its complete composition. The favicon and visible identity load the derivatives successfully.
2. The animation uses Anatomy geometry or projection tools, ships with required source and license, and works without an external network connection.
3. The resting composition has three rounded cards in the selected order and palette. Motion is continuous, keeps the cards inside the stage and returns to the resting composition.
4. Play/pause, replay, timeline interaction and keyboard controls operate on the same animation state.
5. Desktop and 390px light/dark views render cleanly. Reduced motion and hidden-document behavior are exercised.
6. Project type checking and the relevant build complete. Independent review reports actual results and any remaining limitations.

## Deliverables

- `assets/brand/domino/source-icon.png`: untouched selected master.
- `src/web/public/brand/acanvas-icon.png`: 128px product icon.
- `src/web/public/brand/acanvas-favicon.png`: 64px browser icon.
- `assets/brand/domino/index.html`: standalone offline animation, with the selected browser icon embedded.
- `assets/brand/domino/domino.gif`: 500×356, 172 frames at 20fps, an 8.6-second seamless loop.
- `assets/brand/domino/preview.png`: static preview of the composed icon and playback controls.
- `assets/brand/domino/build.mjs`, `model.mjs`, `live.mjs`, `style.css`: editable construction, motion model, controls and presentation.
- `assets/brand/domino/vendor/anatomy/`: required MIT-licensed Anatomy geometry source and license.

The 8.6-second timeline opens with the composed icon, staggers the three cards, and returns to the composed pose. Geometry uses Anatomy's camera, rounded plans and extrusion. The HTML bundles its geometry, styles, controls and favicon; it opens from a local file without network resources.

## Validation and delivery status

Anatomy is installed at `/Users/yingbowu/.codex/skills/anatomy`. Project type checking and an isolated production web build passed. Focused browser checks cover offline loading, continuous playback, pause/replay, pointer scrubbing, keyboard controls, desktop/390px light and dark presentation, reduced-motion inspection and actual offscreen pause/resume. Independent review samples 87 positions across the timeline and verifies that every card stays inside the stage.

The accessible timeline pauses when focused and describes the current model position. The selected master passes byte comparison with the supplied image; 128px and 64px exports provide the product and browser icons.

Native hidden-document verification is limited by this environment: headless Chrome, headed Chrome and Codex's in-app browser retained `document.hidden === false` while another tab was active. Those observations do not establish hidden-document suspension. The `visibilitychange` handler is checked separately with a synthetic hidden-state event; actual offscreen suspension uses the browser's IntersectionObserver.

Independent source, interaction, visual and export review passed with no open actionable findings. The GIF's first and last frames match pixel for pixel; its contact sheet preserves card order, palette and complete return to the icon. Evidence is recorded in [the independent review](evidence/domino-icon/review-20261013/review.md).

An initial review command used the project's default build and wrote `dist/web` before the intended delivery step. The running service retained its process and the review performed no whiteboard API writes. The project's typecheck also compiles server/test output into `dist`; its name does not imply a read-only check. Final product verification uses a Vite build with an explicit temporary output directory.

The accepted web-resource update is complete. The previous review-built entry point was backed up under `/private/tmp/acanvas-domino-verification-20261013/live-backup/`; the accepted entry point was installed atomically and existing web assets were retained. Read-only HTTP checks returned 200 with bytes matching the accepted bundle and 64/128px icon exports. The original service process (PID 56724) remains running. Refresh Acanvas to load the selected icon. Whiteboard data was outside this task's writes.
