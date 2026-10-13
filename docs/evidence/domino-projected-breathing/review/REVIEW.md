# Projected breathing review

Date: 2026-10-13. Result: PASS for the requested bounded geometry/browser review.

The accepted candidate retains upper-left forward travel and uses the user's accepted overall card tilt. Forward projection is `[-1.06238, -0.33806]`. Travel speed is 30.8733 viewBox units/s, versus 76.8685 for the preceding candidate: a 59.8% reduction.

The face determinant crosses from negative to positive between fall ages 700 and 800 ms and expands on either side. The light/dark sheets show eight phases at 32, 64, and 160 px. At 32 px, broad cards remain recognizable; the narrowing/opening arc and negative space are visible.

The first candidate's face-center depth order produced 1,868 incorrect frontmost choices among 2,215 overlapping interior screen samples. The execution agent replaced it with contact-branch ordering across the edge-on pose. The final independent check reads actual Chrome computed z-index at 65 phases and compares it with world-space depth at inverse-projected face intersections. All 2,215 overlapping interior samples now select the correct frontmost face. Samples exclude the rounded-corner boundary by three world units. The original finding is retained in `initial-depth-finding.json`.

All 30 sampled sides of slot recycling lie outside the viewport. Source matrices agree exactly at the full-cycle seam. Generated CSS and TypeScript agree with the source, and the current preview agrees with the main HTML. Browser/source matrix differences are at most 0.00274 coefficient units at sampled times, including a non-keyframe time. Reduced motion has zero active animations. Browser errors: zero.

Evidence: `results.json`, `poses-light.png`, `poses-dark.png`, and reproducible `check.mjs`. Node 24.21.0, isolated Chrome 155.0.8059.40. The first sandboxed Chrome launch ended with SIGABRT before checks; the approved isolated-browser rerun completed. This review does not audit GIF/PNG export bytes or production installation. The product service was untouched.
