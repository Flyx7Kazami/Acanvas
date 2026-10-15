# Slow Signal — generative studies

Four self-contained mobile app directions for the same fictional evening of image and sound. Each entry targets **360 × 640**, with a compact layout at **320 × 600**. Its initial SVG artwork and parameter-driven updates use the same generator. All CSS, JavaScript and SVG are included in the HTML; it needs no network font, image or media request.

| Entry | Direction | Visual parameter | Initial value |
| --- | --- | --- | --- |
| `mobile/01-Precision.html` | Ordered dither, indigo and coral dot fields on lime | Density: 20–90 | 62 |
| `mobile/02-Modular.html` | Eight parametric rosettes, vermilion, lavender, navy and citron | Rhythm: 4–12 | 7 |
| `mobile/03-Chromatic.html` | Two-colour halftone with a translucent triangle and ASCII wave | Phase: 0–100 | 38 |
| `mobile/04-Mono.html` | Black-and-white ASCII optical interference | Frequency: 10–90 | 44 |

Each slider changes the actual SVG: dot density, petal count/rotation, ink-field/ASCII phase or spatial frequency. The pages also support session saving, track selection, adding/removing tracks from Listening, local reservation/release and bottom navigation state. Saved selections and reservations belong to the current document; this study connects to no ticketing service.

Music playback belongs to the separate native Acanvas audio objects. HTML previews preserve Acanvas’s `media-src 'none'` security policy; the mobile studies contain track-selection controls and omit an HTML audio element. `music/Afterimage.mp3` and `music/Small-hours.mp3` preserve the original 12-second and 9-second compositions in `../content/`. Original SVG covers are rasterized to PNG and embedded as ID3 front-cover artwork. Imagegen poster sources under `art/` are supplied separately by the main agent.

Rebuild the HTML and covered audio with Node 24, ffmpeg and sharp available locally:

```sh
ACANVAS_MEDIA_MODULES=<directory-containing-sharp> node build-studies.mjs
```

Verification on 2026-10-15:

- The four current entries pass JavaScript syntax and local-resource checks. Every initial SVG equals its generator’s default output; changing its parameter to the maximum generates different SVG content. Results are in `evidence/parameter-validation.json` and `evidence/resource-validation.json`.
- Dither and halftone geometry uses compound SVG paths: two colour-field paths in Precision and row-wise ink paths in Chromatic. Default/minimum/maximum generated pages contain an estimated 111/203–208/205–208/150 snapshot nodes respectively, including text and two pseudo-elements. The existing 2,000-node and 6 MiB Acanvas snapshot limits remain in force. Detailed counts are in `evidence/path-composition-nodes.json`.
- At 640 × 292, Precision’s compound-path render equals the preceding per-dot render pixel for pixel. Chromatic’s mean channel difference is 0.0197 out of 255; 474 of 186,880 pixels differ by more than three levels around small dot edges. Dot positions, colours, default composition and parameter behaviour are preserved. Measurements are in `evidence/path-composition-visual.json`.
- The production Acanvas `extractAudioArtwork` returns `image/png` for both MP3s. Extracted bytes equal the original PNGs: Afterimage 28,861 bytes; Small hours 34,408 bytes. ffprobe identifies PNG attached-picture streams in both files.
- Current generated hero art is rendered in `evidence/patterns.png`. This image validates the SVG artwork; the parent agent verifies final HTML controls, native previews and whole-board layout through the actual Acanvas interface.
- `evidence/initial/` preserves the preceding standalone browser study. Its 360 × 640/320 × 600 measurements and playback checks describe that earlier HTML revision. Real Acanvas preview testing established the CSP media restriction and led to the current selection-only controls; native audio playback is checked separately.

Final native acceptance on 2026-10-15:

- Density 62→63→62, Rhythm 7→8→7, Phase 38→39→38 and Frequency 44→45→44 were exercised through the original native webview controls.
- The native players reached 12/12 and 9/9 seconds. Studies opened its three current artworks and returned to the board.
- A separate presentation project reproduces the user’s manual layout: all 16 object geometries and three groups match exactly. Only the camera adapts to the 918.5 × 798 native pane. Its final screenshot shows four complete mobile previews and both audio covers, a collapsed queue with three requests, and two image references in the first request. The original interactive example retains the user’s edits.
- Manual mapping and geometry checks are in `evidence/manual-layout-copy.json` and `evidence/manual-layout-projection.json`.
- Results are in `evidence/native-ui-validation.json`, `evidence/presentation-validation.json` and `evidence/native-presentation-final.jpg`.
