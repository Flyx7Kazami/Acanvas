# Continuous grayscale domino loading

Date: 2026-10-13 (Asia/Shanghai).

## Requirement

### Current selection: upper-right to lower-left, unified loading (2026-10-13)

The user chooses the preserved upper-right-to-lower-left grayscale version, requests a modest speed reduction and applies it to existing loading states. The selected 14/30/14 geometry and −35° camera remain; cadence changes from 300ms to 375ms, with proportional timing. Static branding becomes a faithful SVG of the selected green/pink/gray icon. Current implementation and validation are recorded in [Domino SVG and unified loading](DOMINO_UNIFIED.md). The following sections preserve the preceding candidate work.

### Current correction: projected contraction and slower travel (2026-10-13)

The user rejected the density/height candidate's perceived breathing and speed. The supplied comparison shows the earlier view's faces contracting toward an edge-on pose and then reopening, while the newer view retains broad overlapping faces. Acceptance now requires a clearly visible narrowing/opening arc and negative space between the upright group and falling tail, with materially slower screen travel. Height and pitch alone do not establish this result. Keep the bottom-right-to-top-left travel direction where compatible with the projected pose, use coherent projection rather than an independent face-width scaling effect, and compare actual rendered phases before exporting. Preserve the preceding candidate as a separate reference. This supersedes the preceding refinement's appearance acceptance; prior technical checks remain historical evidence.

For the existing upright, parallel, bottom-hinged contact chain, the signed projected area is proportional to `sin(theta) * sin(elevation) - cos(theta) * cos(azimuth) * cos(elevation)`. At azimuth −145°, it keeps one sign throughout the fall. At −35°, it crosses zero and reopens. Rotating the whole projection retains that contraction and the physical contact geometry while changing screen travel direction, and also tilts upright cards on screen. The next preview compares the preserved earlier view at a slower cadence with a rolled-camera candidate, making this appearance/direction tradeoff visible before selecting a production candidate.

The user explicitly chose to keep bottom-right-to-top-left travel and accept tilted card faces. Proceed with a coherent rolled-camera view that contracts through edge-on and reopens, with a slower cadence around 600–750ms. Preserve the earlier unrolled view and the rejected density-only candidate as comparison references.

The selected candidate uses camera azimuth −65°, elevation 28° and roll 30°, applied to the whole projection. Width/height/pitch are 24/34/18, scale is 0.95, origin is [36,44], cadence is 650ms and fallAt is 4745ms. Fifteen slots make a 9750ms cycle. This gives left/up screen travel and a real projected-area zero during the fall. Compared with the preceding 24-pitch/300ms candidate, screen travel is approximately 40% as fast. `comparison/refined-v1.html` and `comparison/model-v1.mjs` preserve that preceding candidate; the three-column page now shows historical, preceding and current views at their own playback speeds.

### Preceding refinement: icon density and height (2026-10-13)

The user asks the bottom-right-to-top-left candidate to recover the earlier direction's breathing room, using the supplied original three-card icon as the reference for density and height. This supersedes the preceding direction-only stage's fixed pitch, scale and quantity. Keep the selected direction, opaque neutral grays, steady camera travel and contact-driven collapse. Refine face proportions, pitch and framing together so upright and turning cards have distinct tall silhouettes and the flattened tail occupies less of the composition. Target roughly three dominant readable cards, with entry and exit partials allowed during continuous travel.

Acceptance for this refinement: inspect several poses at real loading sizes and enlarged; verify complete upright entry before falling, forward-only collapse, offscreen recycling and a continuous loop seam; preserve reduced motion and light/dark rendering. Keep the historical direction and pre-refinement candidate as separate references, and provide a three-way live comparison. This stage delivers source and local preview assets; production resource installation follows selection of the visual result. Actual checks and final parameters are recorded below when complete.

### Refinement result

The final candidate uses width 18, height 36, pitch 24 and corner radius 2.8. Camera origin is [36,54], scale 1.1, azimuth −145° and elevation 28°. The viewport stays 72×64, cadence stays 300ms, and the 15-slot cycle stays 4500ms. Collapse starts at slot age 2225ms. This presents roughly three dominant cards with partial entry and exit faces, and gives the tall central silhouettes more separation from the short exiting tail.

The main preview, portable SVG, generated React geometry/CSS, transparent PNG and light-background GIF are regenerated. The GIF has 135 frames over 4500ms. The [three-way comparison](../assets/brand/domino/comparison/comparison.html) aligns corresponding fall phases using 0/600/425ms local-time offsets; historical and pre-refinement pages remain saved independently. It is self-contained for offline viewing, and is also available from the existing local preview at `http://127.0.0.1:4339/comparison/comparison.html`.

Execution checks passed on Node 24.21.0: 145 contact samples, 2670 monotonic-fall/steady-camera samples, 30 offscreen recycle transitions, exact full-cycle matrix continuity and maximum CSS projection error below 0.00048 world-view units. The full upright silhouette is visible about 122ms before falling. Browser checks cover three poses in both themes, 32/48/64px sizes, reduced motion, 390px comparison layout and console errors. Frontend `--noEmit` and Vite build to `/private/tmp/acanvas-domino-breathing-web` passed. Evidence: [execution results](evidence/domino-breathing/verification.json) and [independent review](evidence/domino-breathing/review/).

This is a local visual refinement. The running product service and its installed web resources retain their prior version, and the selected static PNG icon remains the branding asset. Existing overlapping uncommitted workspace changes are preserved; this refinement remains in the working tree for visual selection.

### Preceding direction-only stage

The user wants dominoes to keep falling while the camera continuously travels along the row. The preceding visual correction sets both collapse and camera advance from bottom-right toward top-left, aligns the row with the original icon diagonal, retains the selected gray reference version's visible quantity for that stage, brings the cards closer together, and changes them to borderless solid fills in different grayscale values. The selected PNG remains the static product icon.

Use the installed Anatomy skill for rounded geometry and isometric projection. Card interiors are now opaque neutral grays; the reusable loading asset background remains transparent. The GIF is a light-background presentation preview.

## Preceding stage: motion and rendering

- The user explicitly selected collapse and camera advance toward the upper-left. The row axis and projected world-forward vector therefore point left/up. Upright cards enter upper-left; fallen cards leave lower-right as stationary world hinges drift opposite the tracking camera.
- The current direction-only stage preserves the first gray reference's quantity, framing, spacing and motion. A later count adjustment is deferred. The selected reference uses 72×64 framing, origin 36/44, scale 1.15, pitch 14 and 15 offscreen-recycling slots.
- Translate the camera steadily along the advancing collapse, keeping the active wave near the center. Continue through the cycle seam with ordinary frame spacing.
- Reduce card pitch visibly from the preceding 22 world units. Keep the row close and connected while preserving readable silhouettes at loading sizes.
- Use a small repeating palette of opaque neutral gray fills with stroke:none. Keep adjacent cards distinguishable and the palette sequence consistent through recycling.
- Model the filled faces with correct contacts and depth/occlusion. For coplanar-width hinged neighbors, a touching pair can use theta_back = theta_front + asin((pitch/height)*cos(theta_front)); this supports a contact-driven advancing wave without intersecting faces.
- Populate enough cards to cover entry, collapse and exit. Recycle each slot only when its entire outline is outside the viewport. The visible scene contains continuous falling and camera travel, with no visible stand-up, backward reset or still interval.
- Share geometry, timing and grayscale fills across React, portable SVG and the offline preview. Preserve the existing product loading integration and keep per-frame React renders out of the animation path.
- Respect reduced motion with a stable still scene and retain the stable loading status.

## Preceding stage: acceptance

1. The projected world-forward/camera/collapse direction has negative screenX and screenY (upper-left); stationary hinges drift lower-right. The row lies on the bottom-right/top-left diagonal, the selected gray reference's visible quantity and scale are preserved, and pitch remains 14 units.
2. Card faces use opaque grayscale fills and no border strokes. The asset background is transparent; light/dark and 32/48/64px render clearly.
3. Each visible card falls once. Recycling is fully outside view; depth order and filled-face overlaps remain correct across entry, collapse, exit and the cycle seam.
4. Camera translation remains steady across the seam. The GIF samples [0,duration) without a duplicate held endpoint; validate normal adjacent-frame motion through wrap.
5. The offline preview, external-image SVG, GIF and product component represent the same advancing filled chain. One delayed ordinary-production startup verifies the revised loading appearance; existing switch wiring is retained.
6. Type checking with --noEmit and an explicit temporary Vite output directory pass. Independent clean-context review checks latest source, gray filled poses, layering, motion and exports.

## Workspace and delivery

Technical execution and focused validation are delegated. The main agent owns this specification, PLAN progress and final commit. Preserve unrelated host-delivery changes. Use explicit isolated build output paths.

The current refinement is delivered through local previews and generated source assets. Production resource installation follows selection of the visual result. Fixture builds remain separate.

## Preceding stage: status

The user selected the earlier gray upper-right-to-lower-left version as the appearance reference, then limited this stage to changing direction while preserving quantity. Separate historical/current previews and synchronized comparison are complete. Further animation adjustments and production delivery remain paused while the user compares them. Earlier-stage checks remain historical evidence rather than acceptance of a newly selected appearance.


## Historical comparison request

The user requests a separate copy of the earlier upper-right-to-lower-left gray preview because the perceived material finish differs. Save both earlier and current scenes independently, leaving the current main preview untouched. Show equal sizes, backgrounds and animation phase in a comparison. Recover the original scene file when available; if rebuilding from retained parameters and screenshots, state that evidence boundary.

The first gray preview used the provisional face-center painter key; the current candidate uses hinge-based depth ordering and a different camera side. Preserve the historical rendering for comparison rather than silently correcting it. Independent comparison confirms that camera azimuth and painter ordering differ, while projection scale, timing, pitch, slot count and palette match. The reconstruction boundary and results are recorded in [the comparison report](DOMINO_LOADING_COMPARISON.md).
