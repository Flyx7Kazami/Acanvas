// Preserve the vector geometry and timing in one reusable animated image document.
import { readFile, writeFile } from 'node:fs/promises';
import { DOMINO_BOUNDS, DOMINO_PATH, DOMINO_TRANSFORMS, DOMINO_VIEWBOX } from '../app/src/web/domino-loader.generated.ts';

const css = await readFile(new URL('../app/src/web/domino-loader.generated.css', import.meta.url), 'utf8');
const cards = DOMINO_TRANSFORMS.map((_, index) => `<div class="domino-layer domino-card-${index}"><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"><path d="${DOMINO_PATH}"/></svg></div>`).join('');
const svg = `<!-- Geometry uses Anatomy projection (MIT); see assets/brand/domino/vendor/anatomy/LICENSE. -->
<svg xmlns="http://www.w3.org/2000/svg" class="domino-loader" width="${DOMINO_BOUNDS[0]}" height="${DOMINO_BOUNDS[1]}" viewBox="${DOMINO_VIEWBOX}" fill="none" stroke="none"><style><![CDATA[${css}]]></style><foreignObject width="${DOMINO_BOUNDS[0]}" height="${DOMINO_BOUNDS[1]}"><div xmlns="http://www.w3.org/1999/xhtml" class="domino-stage">${cards}</div></foreignObject></svg>
`;
await writeFile(new URL('../app/src/web/public/domino-loader.svg', import.meta.url), svg);
await writeFile(new URL('../app/src/web/public/domino-loader-still.svg', import.meta.url), svg.replace(']]></style>', '.domino-layer{animation:none}]]></style>'));
