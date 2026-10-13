# Independent grayscale comparison review

2026-10-13. Result: **PASS for the comparison deliverable**. Main-animation selection and production delivery remain paused.

The earlier gray page is a reconstruction from recorded source facts and retained screenshots. The original full HTML snapshot was absent. Its camera uses azimuth −35°, with the historical provisional center-depth paint key retained. The current copy uses azimuth −145° (215°) and the relative-hinge paint key. These two fields change projected face exposure and layering, producing the visible texture difference.

Both versions retain the same rounded path, 72×64 framing, origin 36/44, scale 1.15, elevation 28°, pitch 14, 15 internal slots, contact motion, 300ms cadence, 4500ms cycle and neutral gray palette. Actual browser transforms agree with the recorded models within 0.000463px. The two paint-key references match exactly at all eight sampled times; the remaining normalized CSS matches.

Historical-image verification used the original 160×128 viewport, DPR2 and 0,75,150,225,300,375,450,525ms poses. The implementation's run recorded zero differing pixels in provenance.json. This independent run found seven tiles pixel-identical and one edge pixel at the 450ms pose differing by 20/255 per channel: 1 pixel out of 655,360. The separate results are preserved in historical-pixel-review.json. This supports faithful visual reconstruction without claiming recovery of the original HTML file.

All three localhost comparison URLs returned HTTP 200. The synchronized page renders equal 160×128 frames and 64×64 marks on the same background. Eight live clock samples show identical local animation time across all 30 animations, with advancing time and zero drift. There were no browser errors. Review requests were GETs to the comparison directory only.

The current.html copy remains byte-identical to the root index.html; the root preview stayed byte-identical during this review. The README reference-strip.png now exists and is byte-identical to the retained historical strip. Historical center-order defects are preserved in the earlier artifact as requested. No open comparison findings remain.

This comparison review added evidence only. It ran no build, changed no animation source or main preview, called no board API, updated no live resource and created no Git commit.
