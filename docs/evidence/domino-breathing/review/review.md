# Domino density and height refinement review

Result: PASS for the local candidate. No blocking findings in the requested scope.

Independent review used Node 24.21.0 and isolated Chrome 155.0.8059.40. The initial sandbox browser launch terminated before loading a page; the approved isolated retry completed. Review scripts and screenshots are confined to this evidence directory. Source, running services and actual board data were left unchanged.

- The new width/height/pitch 18/36/24 composition gives taller, more separated central faces and a shorter flattened tail than the saved 14/30/14 candidate. Eight phases in light and dark at 32/48/64px and enlarged 192px remain legible. Roughly three central readable faces dominate, with substantial entry/exit partials at some phases. This remains a continuous chain and is not a literal three-object scene.
- Offline three-column playback works with a shared clock and constant 0/600/425ms offsets. The three iframe scenes render at equal sizes; the 390px layout fits. The main standalone preview advances in real browser time. Console page errors: zero. Reduced motion removes all animations in both standalone and comparison pages.
- One-millisecond geometric sampling finds a complete upright entry window of about 122ms with a one-unit viewport margin. Collapse is monotonic. Contact residual is at most 1.1e-14 world units. Every recycled slot is outside the viewport immediately before and after reset. The full-cycle matrix seam is exact. Filled-face ordering agrees with the contact-chain geometry and inspected poses show consistent overlaps.
- Source-generated CSS matches the checked-in generated CSS exactly; standalone and refined HTML match exactly. Browser transforms match the analytic model within 0.00049 view units at checked keyframes, including 4500ms.
- GIF is 160×128, 135 frames, 4500ms, with 30/40ms quantized delays. Six independently rendered frames, including the first two and last two, match decoded/composited GIF pixels exactly. Wrap mean channel difference is 0.8825 versus 0.9355 and 0.9107 for adjacent boundary frames, consistent with ordinary continuous motion and no duplicated endpoint hold.
- The transparent preview PNG matches a fresh phase-zero browser render exactly and contains transparent pixels. External-image SVG loads and visibly renders in Chrome.
- Current refinement documentation matches the candidate parameters and explicitly keeps production installation for subsequent visual selection. Type checking and isolated Vite build are execution-side evidence; this independent review did not repeat them or run unrelated test suites.

Evidence: `browser.json`, `geometry.json`, `exports.json`, `comparison-live.png`, `comparison-mobile.png`, `poses-light.png`, `poses-dark.png`, `reduced.png`, `external-svg.png`.

Boundary: this review accepts source/local preview consistency and the requested visual/motion mechanics. User preference for the final breathing feel remains a visual selection. Product startup/switch integration and production installation were not exercised for this preview-only refinement. Historical reference reconstruction remains the preceding review's documented evidence.
