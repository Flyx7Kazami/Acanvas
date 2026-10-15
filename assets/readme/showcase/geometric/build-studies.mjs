import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Local reproduction: ACANVAS_MEDIA_MODULES=<directory containing sharp> node build-studies.mjs
const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sharp = require(process.env.ACANVAS_MEDIA_MODULES ? join(process.env.ACANVAS_MEDIA_MODULES, 'sharp') : 'sharp');
const music = join(root, 'music');
const mobile = join(root, 'mobile');
await mkdir(music, { recursive: true });
await mkdir(mobile, { recursive: true });
const svg = (body, view = '0 0 600 600') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" preserveAspectRatio="xMidYMid slice">${body}</svg>`;

const afterimage = svg(`<rect width="600" height="600" fill="#1e348b"/>
<path d="M70 120h230v230H70zM300 350h230v230H300z" fill="#b9e962"/>
<path d="M70 350a230 230 0 01230-230v230zm230 0a230 230 0 01230-230v230z" fill="#ef885d"/>
<path d="M70 350a230 230 0 00230 230V350zm230 0a230 230 0 00230 230V350z" fill="#b0a3ea"/>
<circle cx="300" cy="350" r="62" fill="#16204b"/>
<g fill="#f7f4e9" font-family="Arial,Helvetica,sans-serif"><text x="40" y="54" font-size="17" letter-spacing="2">SLOW SIGNAL / STUDIO 04</text><text x="40" y="96" font-size="37" font-weight="700" letter-spacing="-1">Afterimage</text><text x="40" y="581" font-size="14" letter-spacing="2">SS—01</text><text x="468" y="581" font-size="14" letter-spacing="2">00:12</text></g>`);
const smallHours = svg(`<rect width="600" height="600" fill="#edb7ce"/>
<rect x="56" y="139" width="488" height="384" fill="#392147"/>
${Array.from({ length: 7 }, (_, n) => `<path d="M${56 + n * 70} 139v384h70V139z" fill="${n % 2 ? '#f4a339' : '#392147'}"/><path d="M${56 + n * 70} 139a70 70 0 010 140a70 70 0 000 140a70 70 0 010 140" fill="none" stroke="${n % 2 ? '#f6e6ce' : '#60b8a6'}" stroke-width="34"/>`).join('')}
<g fill="#392147" font-family="Arial,Helvetica,sans-serif"><text x="40" y="54" font-size="17" letter-spacing="2">SLOW SIGNAL / STUDIO 04</text><text x="40" y="101" font-size="43" font-weight="700" letter-spacing="-2">Small hours</text><text x="40" y="579" font-size="14" letter-spacing="2">SS—02</text><text x="470" y="579" font-size="14" letter-spacing="2">00:09</text></g>`);
for (const [name, artwork] of [['Afterimage', afterimage], ['Small-hours', smallHours]]) {
  await writeFile(join(music, `${name}.svg`), artwork);
  await sharp(Buffer.from(artwork)).png().toFile(join(music, `${name}.png`));
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner','-loglevel','error','-y',
    '-i',resolve(root,'../content',`${name}.wav`),'-i',join(music,`${name}.png`),
    '-map','0:a:0','-map','1:v:0','-c:a','libmp3lame','-b:a','192k','-c:v','copy',
    '-id3v2_version','3','-metadata',`title=${name.replace('-', ' ')}`,'-metadata','artist=Slow Signal',
    '-metadata','album=Image & sound','-metadata:s:v','title=Album cover','-metadata:s:v','comment=Cover (front)',
    '-disposition:v','attached_pic',join(music,`${name}.mp3`)]);
}

const icon = (type, attrs = '') => {
  const paths = { heart: '<path d="M20.8 4.6a5.5 5.5 0 00-7.8 0l-1 1-1-1a5.5 5.5 0 00-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 000-7.8z"/>', arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>', grid:'<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/>', sound:'<path d="M3 10v4M7 6v12M12 3v18M17 7v10M21 10v4"/>', ticket:'<path d="M4 5h16v5a2 2 0 000 4v5H4v-5a2 2 0 000-4zM14 5v14"/>', plus:'<path d="M12 5v14M5 12h14"/>', check:'<path d="M5 12l4 4L19 6"/>', chevron:'<path d="M9 5l7 7-7 7"/>' };
  return `<svg ${attrs} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[type]}</svg>`;
};
function renderGraphic(theme, rawValue) {
  const value = Number(rawValue);
  const wrap = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 146" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${theme} sound pattern">${body}</svg>`;
  const art = [];
  if (theme === 'precision') {
    art.push('<rect width="320" height="146" fill="#dce6dd"/><rect x="88" width="232" height="146" fill="#c7e664"/>');
    const order = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
    // Compound paths represent each printed colour field as one SVG element.
    const ringDots = [], discDots = [];
    for (let row = 0; row < 58; row++) {
      for (let col = 0; col < 128; col++) {
        const x = col * 2.5 + 1.25, y = row * 2.5 + 1.25;
        const dx = (x - 202) / 109, dy = (y - 73) / 69;
        const r = Math.sqrt(dx * dx + dy * dy);
        const ring = r > .27 && r < 1.01;
        const density = .26 + value / 175 + .24 * Math.cos(r * 9.5 - 2) + .18 * dx;
        const threshold = order[(row % 4) * 4 + col % 4] / 16;
        if (ring && threshold < density) ringDots.push(`M${x.toFixed(1)} ${y.toFixed(1)}h1.85v1.85h-1.85z`);
        const disc = (x - 53) ** 2 + (y - 73) ** 2 < 43 ** 2;
        if (disc && threshold < .40 + .35 * (1 - (x - 10) / 86)) discDots.push(`M${x.toFixed(1)} ${y.toFixed(1)}h2v2h-2z`);
      }
    }
    art.push(`<path d="${ringDots.join('')}" fill="#243c85"/><path d="${discDots.join('')}" fill="#df7656"/>`);
    art.push('<path d="M88 0v146M0 73h320" stroke="#243c85" stroke-width=".5" opacity=".4"/><path d="M22 17h16m-8-8v16M274 128h22m-11-11v22" stroke="#243c85" stroke-width=".8"/><rect x="14" y="126" width="50" height="6" fill="#243c85"/><text x="14" y="141" font-family="monospace" font-size="5.5" fill="#243c85" letter-spacing="1">ORDERED / SS—01</text>');
    return wrap(art.join(''));
  }
  if (theme === 'modular') {
    const palette = ['#ee593f','#b9d83d','#e9c53d','#c7addb','#273168','#f2e9d8'];
    art.push('<rect width="320" height="146" fill="#273168"/>');
    for (let cell = 0; cell < 8; cell++) {
      const col = cell % 4, row = Math.floor(cell / 4);
      const count = 4 + (Math.round(value) + cell * 2) % 7;
      const background = palette[cell % palette.length];
      const ink = palette[(cell + 3) % palette.length];
      art.push(`<g transform="translate(${col * 80},${row * 73})"><rect width="80" height="73" fill="${background}"/><g transform="translate(40,36.5) rotate(${value * 4 + cell * 19})">`);
      for (let petal = 0; petal < count; petal++) art.push(`<ellipse cx="0" cy="-17" rx="${8 + cell % 3}" ry="18" fill="${ink}" transform="rotate(${petal * 360 / count})"/>`);
      art.push(`</g><circle cx="40" cy="36.5" r="${5 + cell % 3}" fill="${palette[(cell + 1) % palette.length]}"/><circle cx="40" cy="36.5" r="29" fill="none" stroke="${ink}" stroke-width=".5"/><path d="M5 5h9M5 5v9M75 68h-9M75 68v-9" fill="none" stroke="${ink}" stroke-width=".7"/></g>`);
    }
    return wrap(art.join(''));
  }
  if (theme === 'chromatic') {
    const phase = value / 100 * Math.PI * 2;
    art.push('<rect width="320" height="146" fill="#e0d2e8"/><path d="M15 146V0h95v146z" fill="#f1cfc2"/><path d="M196 0h124v146H196z" fill="#c9ddd9"/>');
    const circlePath = (cx, cy, radius) => {
      const r = Number(radius.toFixed(2));
      const x = Number(cx.toFixed(1)), y = Number(cy.toFixed(1));
      const diameter = (r * 2).toFixed(2);
      return `M${(x - r).toFixed(2)} ${y}a${r} ${r} 0 1 0 ${diameter} 0a${r} ${r} 0 1 0 -${diameter} 0z`;
    };
    // Row groups preserve the ink fields' vertical paint order.
    for (let row = 0; row < 46; row++) {
      const pinkDots = [], blueDots = [];
      for (let col = 0; col < 100; col++) {
        const x = col * 3.2 + 1.6, y = row * 3.2 + 1.6;
        const a = Math.max(0, 1 - Math.hypot((x - 115 - Math.sin(phase) * 20) / 110, (y - 74) / 92));
        const b = Math.max(0, 1 - Math.hypot((x - 213) / 107, (y - 65 - Math.cos(phase) * 18) / 81));
        if (a > 0) pinkDots.push(circlePath(x, y, .22 + a * 1.65));
        if (b > 0) blueDots.push(circlePath(x + .9, y + .7, .2 + b * 1.6));
      }
      if (pinkDots.length) art.push(`<path d="${pinkDots.join('')}" fill="#bd4278"/>`);
      if (blueDots.length) art.push(`<path d="${blueDots.join('')}" fill="#366c9d" opacity=".85"/>`);
    }
    art.push('<path d="M160 16l81 112H79z" fill="#e9bf50" opacity=".3"/>');
    const chars = ' .:+=*#';
    for (let row = 0; row < 7; row++) {
      let line = '';
      for (let col = 0; col < 66; col++) {
        const amplitude = .5 + .5 * Math.sin(col * .24 + phase + row * .58);
        line += chars[Math.min(chars.length - 1, Math.floor(amplitude * chars.length))];
      }
      art.push(`<text x="16" y="${101 + row * 5.5}" font-size="6.5" font-family="monospace" fill="#50305f" opacity=".85" xml:space="preserve">${line}</text>`);
    }
    return wrap(art.join(''));
  }
  art.push('<rect width="320" height="146" fill="#171719"/>');
  const chars = ' .:-=+*#%@';
  const frequency = 3 + value / 30;
  for (let row = 0; row < 24; row++) {
    let line = '';
    for (let col = 0; col < 72; col++) {
      const x = (col - 35.5) / 35.5, y = (row - 11.5) / 18;
      const r = Math.hypot(x, y);
      const wave = .5 + .5 * Math.sin(r * frequency * 4 + Math.atan2(y, x) * 2);
      const mask = Math.min(1, Math.max(0, (1.16 - r) * 5));
      const contrast = Math.max(0, (wave - .34) / .66) * mask;
      const level = Math.min(9, Math.floor(contrast * 10));
      line += chars[level];
    }
    art.push(`<text x="4.5" y="${7 + row * 6}" font-size="7.2" font-family="monospace" fill="#e8e8e3" xml:space="preserve">${line}</text>`);
  }
  return wrap(art.join(''));
}
const parameters = {
  precision: { label: 'Density', value: 62, min: 20, max: 90, step: 1 },
  modular: { label: 'Rhythm', value: 7, min: 4, max: 12, step: 1 },
  chromatic: { label: 'Phase', value: 38, min: 0, max: 100, step: 1 },
  mono: { label: 'Frequency', value: 44, min: 10, max: 90, step: 1 }
};
const visual = theme => {
  const parameter = parameters[theme];
  return `<div class="hero">${renderGraphic(theme, parameter.value)}</div><label class="visual-control"><span>${parameter.label}</span><input id="visual-parameter" aria-label="${parameter.label}" type="range" min="${parameter.min}" max="${parameter.max}" step="${parameter.step}" value="${parameter.value}"><output for="visual-parameter">${parameter.value}</output></label>`;
};
const mini = (variant = 'after') => variant === 'after' ? svg(`<rect width="50" height="50" fill="#223989"/><path d="M5 5h20v20H5zm20 20h20v20H25z" fill="#bee761"/><path d="M5 25a20 20 0 0020 20V25zm20 0a20 20 0 0120-20v20z" fill="#ee8c66"/>`, '0 0 50 50') : svg(`<rect width="50" height="50" fill="#efb6cc"/><path d="M6 6h38v38H6z" fill="#422944"/><path d="M12 7v36m13-36v36m13-36v36" stroke="#f0a43b" stroke-width="8"/>`, '0 0 50 50');
const navigation = `<nav class="navigation" aria-label="Main"><button class="nav active" data-nav="Discover" aria-pressed="true">${icon('grid')}<span>Discover</span></button><button class="nav" data-nav="Listening" aria-pressed="false">${icon('sound')}<span>Listening</span></button><button class="nav" data-nav="Your pass" aria-pressed="false">${icon('ticket')}<span>Your pass</span></button></nav>`;
const filters = (a='Tonight',b='All sessions') => `<div class="filters" aria-label="Session filter"><button class="filter selected" aria-pressed="true" data-filter="${a}">${a}</button><button class="filter" aria-pressed="false" data-filter="${b}">${b}</button></div>`;
const track = (alt = false) => `<div class="track"><div class="track-art">${mini(alt?'small':'after')}</div><div class="track-copy"><strong>${alt?'Small hours':'Afterimage'}</strong><span>${alt?'Warm pulse':'Ambient sketch'} · ${alt?'00:09':'00:12'}</span></div><button class="track-action" aria-label="Add ${alt?'Small hours':'Afterimage'} to Listening" aria-pressed="false">${icon('plus')}</button></div>`;
const reserve = (text='Get your pass') => `<button class="reserve">${text}${icon('arrow')}</button>`;
const base = `*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overscroll-behavior:none}body{font-family:Arial,Helvetica,sans-serif;background:var(--paper);color:var(--ink)}button{font:inherit;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}button svg{width:20px;height:20px;flex:none}button{border:0;background:none}svg{display:block;width:100%;height:100%}.app{height:100svh;max-height:720px;max-width:440px;margin:auto;display:flex;flex-direction:column;position:relative;overflow:hidden}main{flex:1;min-height:0;display:flex;flex-direction:column;padding:0 20px}.brandbar{display:flex;align-items:center;justify-content:space-between;height:50px;padding:10px 20px;flex:none}.brand{font-size:12px;font-weight:700;letter-spacing:1.4px;display:flex;align-items:center;gap:8px}.brandmark{width:17px;height:17px;display:inline-block;background:currentColor;border-radius:50%;position:relative}.brandmark:after{content:'';position:absolute;background:var(--paper);width:7px;height:17px;left:5px}.save{width:30px;height:30px;display:grid;place-items:center;padding:4px}.save[aria-pressed=true] svg{fill:currentColor}.eyebrow{font-size:9px;letter-spacing:1.5px;font-weight:700;text-transform:uppercase;line-height:10px;height:10px;flex:none}.headline{margin:8px 0 12px;line-height:.9;letter-spacing:-2.3px;font-size:44px;height:80px;flex:none}.hero{height:146px;flex:none;overflow:hidden}.visual-control{height:26px;flex:none;display:grid;grid-template-columns:52px 1fr 22px;gap:10px;align-items:center;font-size:8px;letter-spacing:.4px}.visual-control output{text-align:right;font-variant-numeric:tabular-nums}.visual-control input{width:100%;height:15px;margin:0;accent-color:var(--ink);cursor:pointer}.visual-control input:focus-visible{outline:2px solid var(--ink);outline-offset:2px}.meta{height:32px;flex:none;display:flex;justify-content:space-between;align-items:center;font-size:10px;line-height:1.45;padding:6px 0}.filters{height:34px;flex:none;display:flex;gap:6px;margin:8px 0 6px;align-items:center}.filter{font-size:10px;padding:5px 10px;border:1px solid var(--line);border-radius:20px}.filter.selected{background:var(--ink);color:var(--paper);border-color:var(--ink)}.track{display:flex;align-items:center;gap:10px;height:54px;min-height:54px;flex:none;padding:6px 0}.track-art{width:43px;height:43px;flex:none;overflow:hidden}.track-copy{display:flex;flex-direction:column;gap:5px;flex:1}.track-copy strong{font-size:12px;font-weight:600}.track-copy span{font-size:9px;opacity:.65}.track-action{width:35px;height:35px;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center;padding:7px}.track-action[aria-pressed=true]{background:var(--ink);color:var(--paper)}.programme{margin-top:14px;border-top:1px solid var(--line);padding-top:10px;display:flex;justify-content:space-between;font-size:9px;line-height:1.5}.programme strong{font-weight:500;opacity:.55;display:block}.reserve{margin-top:auto;display:flex;justify-content:space-between;align-items:center;width:100%;height:40px;padding:10px 14px;background:var(--ink);color:var(--paper);font-size:11px;font-weight:700;flex:none}.reserve.confirmed{background:var(--accent);color:var(--ink)}.navigation{display:flex;justify-content:space-between;align-items:center;height:48px;margin:8px 20px 0;border-top:1px solid var(--line);padding:9px 6px 10px;flex:none}.nav{display:flex;align-items:center;gap:6px;font-size:9px;padding:4px 0;opacity:.45}.nav.active{opacity:1}.nav svg{width:17px;height:17px}.toast{position:absolute;left:20px;right:20px;bottom:74px;padding:10px 12px;font-size:11px;background:var(--ink);color:var(--paper);box-shadow:0 4px 24px #0002;z-index:2;transform:translateY(8px);opacity:0;transition:opacity .18s,transform .18s;pointer-events:none}.toast.visible{transform:translateY(0);opacity:1}.section-label{display:flex;justify-content:space-between;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.3px;height:12px;line-height:12px;flex:none}.section-label span:last-child{font-weight:400;letter-spacing:0}@media(max-height:620px){.headline{font-size:40px;height:72px;margin-top:6px;margin-bottom:10px}.hero{height:126px}.filters{margin-top:6px;margin-bottom:4px}.navigation{height:44px;margin-top:6px}.programme{margin-top:10px;padding-top:8px}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;
const directions = [
  { file:'01-Precision.html',name:'Precision', theme:'precision',track:'Afterimage',css:`:root{--paper:#edf0ef;--ink:#203780;--accent:#b9eb59;--line:#20378036}.brandmark{border-radius:0;transform:rotate(45deg);width:13px;height:13px}.brandmark:after{width:5px;height:13px;left:4px}.headline{font-weight:500;letter-spacing:-2.8px}.headline strong{font-weight:800}.track{border-top:1px solid var(--line)}`,
    body:`<div class="eyebrow">Nov 21 / Shanghai</div><h1 class="headline">Listen<br>in <strong>colour.</strong></h1>${visual('precision')}<div class="meta"><strong>Studio 04</strong><span>19:00—23:00<br>Image & sound</span></div>${filters()}<div class="section-label"><span>First listen</span><span>SS—01</span></div>${track()}${reserve()}` },
  { file:'02-Modular.html',name:'Modular',theme:'modular',track:'Small-hours',css:`:root{--paper:#eee9dc;--ink:#242b62;--accent:#c1d737;--line:#242b6233}.brandbar{background:var(--paper)}main{padding:0 14px}.brandbar{padding-left:14px;padding-right:14px}.brandmark{border-radius:0;background:#ef553e}.brandmark:after{width:8px;height:8px;left:9px;top:9px;background:#c1d737}.headline{font-family:'Arial Black',Arial,sans-serif;font-weight:900;letter-spacing:-3px}.headline span{display:block;text-align:right;color:#ef553e}.meta{background:#242b62;color:#eee9dc;padding-left:12px;padding-right:12px}.eyebrow{display:flex;justify-content:space-between}.filter{border-radius:0;font-weight:700}.filter.selected{background:#c1d737;color:#242b62;border-color:#c1d737}.track-action{background:#ef553e;border:0;border-radius:0;color:var(--paper)}.reserve{background:#242b62}.navigation{margin-left:14px;margin-right:14px}.track-art{width:40px;height:40px}`,
    body:`<div class="eyebrow"><span>Image ↔ Sound</span><span>21 Nov</span></div><h1 class="headline">SLOW<span>SIGNAL</span></h1>${visual('modular')}<div class="meta"><strong>STUDIO 04</strong><span>SHANGHAI · 19:00</span></div>${filters('Tonight','Late sessions')}<div class="section-label"><span>Warm pulse</span><span>SS—02</span></div>${track(true)}${reserve('Join the session')}` },
  { file:'03-Chromatic.html',name:'Chromatic',theme:'chromatic',track:'Afterimage',css:`:root{--paper:#f3e9f1;--ink:#4d355f;--accent:#d9b95f;--line:#4d355f30}.brand{letter-spacing:.6px;font-weight:500}.brandmark{background:#d988a3}.brandmark:after{background:#7e8caf;width:9px;left:8px}.headline{font-family:Georgia,'Times New Roman',serif;font-weight:400;letter-spacing:-2px}.headline em{font-weight:400}.eyebrow{font-size:9px;letter-spacing:1px;font-weight:400}.hero{border-radius:72px 72px 8px 8px}.meta{padding-left:2px;padding-right:2px}.filter{border-color:#b9a2c1}.filter.selected{background:#d7c1df;color:#4d355f;border-color:#d7c1df}.track{padding-left:10px;padding-right:10px;background:#e9ddeb;border-radius:9px}.track-art{border-radius:6px}.track-action{border:0;background:#f3e9f1}.reserve{border-radius:22px;font-weight:500;background:#4d355f}.navigation{border-color:#4d355f25}.nav.active{color:#7b4577}`,
    body:`<div class="eyebrow">An evening of image & sound</div><h1 class="headline">Follow the<br><em>feeling.</em></h1>${visual('chromatic')}<div class="meta"><strong>November 21</strong><span>Studio 04 · Shanghai</span></div>${filters('For you','All sessions')}<div class="section-label"><span>A softer frequency</span><span>First listen</span></div>${track()}${reserve('Save your evening')}` },
  { file:'04-Mono.html',name:'Mono',theme:'mono',track:'Small-hours',css:`:root{--paper:#e8e8e3;--ink:#171719;--accent:#bbbcb6;--line:#17171945}.brand{font-size:10px;letter-spacing:2px}.brandmark{border-radius:0}.brandmark:after{transform:rotate(45deg);width:4px;left:6px}.headline{font-family:'Arial Black',Arial,sans-serif;font-weight:900;letter-spacing:-3.6px}.eyebrow{display:flex;justify-content:space-between;font-size:8px}.meta{border-bottom:1px solid var(--ink)}.meta strong{font-weight:700}.filter{border:0;border-bottom:2px solid transparent;border-radius:0;padding:4px 0;margin-right:16px;font-size:9px}.filter.selected{background:none;color:var(--ink);border-color:var(--ink)}.track-art{filter:grayscale(1)}.track-action{border-color:var(--ink);border-radius:0}.navigation{border-top:1px solid var(--ink)}.save{padding:5px}`,
    body:`<div class="eyebrow"><span>Listening room / 2026</span><span>Shanghai</span></div><h1 class="headline">MAKE<br>ROOM.</h1>${visual('mono')}<div class="meta"><strong>21 NOV · STUDIO 04</strong><span>19:00—23:00</span></div>${filters('Tonight','After hours')}<div class="section-label"><span>Your selection</span><span>SS—02</span></div>${track(true)}${reserve('Reserve a place')}` }
];

for (const d of directions) {
  const alternate = d.track === 'Afterimage' ? 'Small-hours' : 'Afterimage';
  const script = `
const renderGraphic = ${renderGraphic.toString()};
const parameter = document.getElementById('visual-parameter');
parameter.oninput = () => {
  document.querySelector('.hero').innerHTML = renderGraphic(${JSON.stringify(d.theme)}, parameter.value);
  document.querySelector('.visual-control output').value = parameter.value;
};
const trackAction = document.querySelector('.track-action');
const toast = document.querySelector('.toast');
const listening = new Set();
let timer;
let currentTitle = ${JSON.stringify(d.track.replace('-', ' '))};
function notify(text) {
  toast.textContent = text;
  toast.classList.add('visible');
  clearTimeout(timer);
  timer = setTimeout(() => toast.classList.remove('visible'), 2200);
}
function showTrackState() {
  const saved = listening.has(currentTitle);
  trackAction.setAttribute('aria-pressed', saved);
  trackAction.setAttribute('aria-label', (saved ? 'Remove ' : 'Add ') + currentTitle + (saved ? ' from Listening' : ' to Listening'));
  trackAction.innerHTML = saved ? ${JSON.stringify(icon('check'))} : ${JSON.stringify(icon('plus'))};
}
document.querySelector('.save').onclick = function () {
  const saved = this.getAttribute('aria-pressed') !== 'true';
  this.setAttribute('aria-pressed', saved);
  this.setAttribute('aria-label', saved ? 'Remove from saved' : 'Save this session');
  notify(saved ? 'Session saved to Listening.' : 'Session removed from Listening.');
};
trackAction.onclick = () => {
  const saved = listening.has(currentTitle);
  if (saved) listening.delete(currentTitle);
  else listening.add(currentTitle);
  showTrackState();
  notify(currentTitle + (saved ? ' removed from Listening.' : ' added to Listening.'));
};
document.querySelector('.reserve').onclick = function () {
  this.classList.toggle('confirmed');
  const reserved = this.classList.contains('confirmed');
  this.innerHTML = (reserved ? 'You’re on the list' : ${JSON.stringify(d.theme === 'modular' ? 'Join the session' : d.theme === 'chromatic' ? 'Save your evening' : d.theme === 'mono' ? 'Reserve a place' : 'Get your pass')}) + (reserved ? ${JSON.stringify(icon('check'))} : ${JSON.stringify(icon('arrow'))});
  notify(reserved ? 'November 21 · Studio 04. Your place is reserved.' : 'Reservation released.');
};
document.querySelectorAll('.filter').forEach(button => button.onclick = () => {
  document.querySelectorAll('.filter').forEach(s => {
    s.classList.toggle('selected', s === button);
    s.setAttribute('aria-pressed', s === button);
  });
  const second = button === document.querySelectorAll('.filter')[1];
  currentTitle = second ? ${JSON.stringify(alternate.replace('-', ' '))} : ${JSON.stringify(d.track.replace('-', ' '))};
  document.querySelector('.track-copy strong').textContent = currentTitle;
  document.querySelector('.track-copy span').textContent = currentTitle === 'Afterimage' ? 'Ambient sketch · 00:12' : 'Warm pulse · 00:09';
  document.querySelector('.track-art').innerHTML = currentTitle === 'Afterimage' ? ${JSON.stringify(mini())} : ${JSON.stringify(mini('small'))};
  showTrackState();
  notify(button.dataset.filter);
});
document.querySelectorAll('.nav').forEach(button => button.onclick = () => {
  document.querySelectorAll('.nav').forEach(n => {
    n.classList.toggle('active', n === button);
    n.setAttribute('aria-pressed', n === button);
  });
  notify(button.dataset.nav === 'Your pass'
    ? (document.querySelector('.reserve').classList.contains('confirmed') ? 'Studio 04 · November 21 · Reserved' : 'Reserve your place for November 21.')
    : button.dataset.nav === 'Listening' ? 'Listening · ' + listening.size + (listening.size === 1 ? ' track' : ' tracks') : 'Discover tonight’s image & sound sessions.');
});
`;

  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Slow Signal — ${d.name}</title><style>${base}${d.css}</style></head><body><div class="app ${d.theme}"><header class="brandbar"><div class="brand"><span class="brandmark" aria-hidden="true"></span>SLOW SIGNAL</div><button class="save" aria-label="Save this session" aria-pressed="false">${icon('heart')}</button></header><main>${d.body.replace(/(<button class="reserve">)/, '<div class="programme"><span><strong>20:00</strong>Live ambient</span><span><strong>21:30</strong>Open listening room</span></div>$1')}</main>${navigation}<div class="toast" role="status" aria-live="polite"></div></div><script>${script}</script></body></html>`;
  await writeFile(join(mobile,d.file),html);
}
await writeFile(join(root,'studies.json'),JSON.stringify({canvas:{width:360,height:640},mobile:directions.map(d=>({entry:`mobile/${d.file}`,direction:d.name,parameter:parameters[d.theme],interactions:['adjust visual parameter','save session','add/remove track from Listening','session filter','reserve/release place','bottom navigation']})),music:[{path:'music/Afterimage.mp3',durationSeconds:12,originalSource:'../content/Afterimage.wav',cover:'music/Afterimage.png'},{path:'music/Small-hours.mp3',durationSeconds:9,originalSource:'../content/Small-hours.wav',cover:'music/Small-hours.png'}]},null,2)+'\n');
console.log(`Built ${directions.length} mobile studies and 2 MP3 tracks with embedded cover art.`);
