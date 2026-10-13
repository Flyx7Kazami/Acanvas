# Domino loading animation

Date: 2026-10-13 (Asia/Shanghai).

## Requirement

The user requests a loading animation built from the selected three-card domino mark: pure outlines, a clear sequential domino collapse, and continuous looping. Use the installed Anatomy skill's projection and rounded geometry tools. The requested outline style determines the rendering.

The selected PNG remains the static product icon. The loading mark is a small monochrome outline that inherits the surrounding text color and works on transparent backgrounds.

## Behavior and implementation

- Three rounded upright domino outlines topple in sequence, rotating around their bottom edges until clearly lying down. Use actual projected rotation so the movement reads as falling in depth.
- A brief settled pose and smooth staggered reset join the next fall into a continuous periodic loop, approximately two seconds long.
- Render strokes with transparent interiors. Keep the mark free of fills, surface shading, gradients, shadows, pips and framing.
- Provide a reusable React loading component and a portable animated SVG. Precompute projection with Anatomy; prefer CSS/SVG animation with no per-frame React render.
- Use the component for opening a board and the board-switch loading indicator. Keep unrelated compact progress controls in their existing form.
- The product loading state presents only its normal product copy and the loader. The standalone preview opens directly to the small loading animation, with its current theme colors.
- Reduced motion presents a still recognizable outline mark. Expose a single stable loading status rather than announcements from each frame.

## Acceptance

1. The reusable app component, portable SVG and PNG render only strokes with transparent interiors and backgrounds. The GIF is a light-background presentation preview for chat.
2. The falling stage visibly rotates the cards close to horizontal. Each card follows the preceding card, and the loop returns continuously to the same pose.
3. The animation reads clearly at 32px, 48px and 64px. Light/dark and 390px preview/application views fit.
4. Startup and the existing board-switch loading branch use the shared component. Delayed-loading browser verification exercises real startup with isolated API fixtures. The internal switching branch is inspected and rendered through a fixture; the current app exposes no user session-switch control.
5. The portable SVG and app component use the same generated geometry and timing. The standalone HTML works offline.
6. Relevant type checking and a web build into an explicit temporary output directory pass. Independent clean-context review checks final source, visual poses and functional integration.

## Delivery and existing work

Technical implementation and focused validation are delegated. The main agent owns this specification, plan updates and final Git commit. Preserve the existing unrelated host-delivery changes in App.tsx, styles.css and the other dirty files.

Use explicit isolated build output paths. The runtime wrapper's typecheck/build commands emit files to dist; choose direct TypeScript checks with `--noEmit` and a Vite `--outDir` for verification. After acceptance, install the accepted web assets and entry point through the reversible web-resource update, keeping the existing service running and user board data outside this task's writes.

## Status

The shared `src/web/DominoLoader.tsx` renders three rounded outline paths from generated geometry. `src/web/domino-loader.generated.ts` and `domino-loader.generated.css` are built with the portable SVG from `assets/brand/domino/model.mjs` and `build.mjs`.

Each card rotates around its world-space bottom hinge from −8° to 86°, staggered by 135ms, within a two-second loop. CSS animates typed numeric projection vectors; the React component renders a stable SVG. The portable `assets/brand/domino/domino.svg` embeds the same styles and geometry, and `index.html` is a minimal offline preview.

The actual preview and six key poses show the sequential collapse, fully flat pose and reset. Both TypeScript configurations passed checks with `--noEmit`; the Vite production build uses an explicit temporary output directory. Nine product checks passed with zero browser errors, including delayed startup on the ordinary production bundle and the real useBoard/App switching branch invoked through an isolated fixture bridge. That bridge exists only in the fixture build; the ordinary production candidate is separate.

The refreshed `domino.gif` is a light-background presentation preview: 160×128, 60 frames and exactly two seconds. `preview.png` is a transparent 64px outline. The portable SVG also animates when embedded as an external image.

Independent source, product, visual and export review passed with no open actionable findings. Twelve browser checks completed with zero errors. They cover small sizes, actual light/dark product themes, transparent asset corners, reduced-motion stillness and the loop seam. GIF timing totals exactly 2000ms and its first/last composited frames match. Implementation evidence is recorded in [validation.md](evidence/domino-loading/implementation-20261013/validation.md); independent results are in [review.md](evidence/domino-loading/review-20261013/review.md).

Live web-resource delivery is complete, using the ordinary accepted production build. Existing web assets were retained and the entry point was replaced atomically. Read-only HTTP checks match the accepted entry point and referenced JS/CSS; the existing service process (PID 56724) continues running. The separate fixture build and its hook bridge remain outside deployment. Delivery evidence is recorded in [live-update.json](evidence/domino-loading/implementation-20261013/live-update.json).
