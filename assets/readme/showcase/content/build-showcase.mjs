import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const content = dirname(fileURLToPath(import.meta.url));
const installation = resolve(content, '../../../..');
const project = process.argv[2];
const session = process.argv[3];
if (!project || !session) throw new Error('Pass an isolated project root and session ID.');
const run = promisify(execFile);
const command = async (...args) => JSON.parse((await run(process.execPath, [join(installation, 'scripts/acanvas.mjs'), ...args, '--project', project, '--session', session], { cwd: installation })).stdout);
const json = async (name, value) => { const path = join(project, name); await writeFile(path, JSON.stringify(value, null, 2)); return path; };
const imported = {};
const objects = [];
const ink = '#20232B', paper = '#F2F0E8';
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feBlend in="SourceGraphic" mode="soft-light"/></filter></defs>${body}</svg>`;
const save = (name, data) => writeFile(join(content, name), data);
await save('wordmark.svg', svg(600, 180, `<rect width="600" height="180" fill="${paper}"/><text x="22" y="74" fill="${ink}" font-family="Arial,Helvetica,sans-serif" font-weight="900" font-size="78" letter-spacing="-5">SLOW SIGNAL</text><path d="M22 96H578" stroke="${ink}"/><text x="24" y="129" fill="${ink}" font-family="Arial,Helvetica,sans-serif" font-size="16" letter-spacing="2">AN EVENING OF IMAGE &amp; SOUND</text><text x="24" y="158" fill="${ink}" font-family="Arial,Helvetica,sans-serif" font-size="11">21 NOVEMBER 2026</text><text x="470" y="158" fill="${ink}" font-family="Arial,Helvetica,sans-serif" font-size="11">STUDIO 04</text>`));
await save('signal-study.svg', svg(390, 250, `<rect width="390" height="250" fill="#20232B"/><g fill="none" stroke="#F2F0E8" stroke-width="2" opacity=".8">${Array.from({length:23},(_,i)=>`<ellipse cx="195" cy="127" rx="${24+i*6.1}" ry="${10+i*3.2}" transform="rotate(${i*3-28} 195 127)"/>`).join('')}</g><text x="16" y="232" fill="#F2F0E8" font-family="Arial" font-size="11" letter-spacing="2">SIGNAL STUDY / 013</text>`));
await save('lineup.svg', svg(260, 330, `<rect width="260" height="330" fill="${paper}"/><text x="18" y="35" fill="${ink}" font-family="Arial" font-size="12" letter-spacing="2">LIVE SESSIONS</text><path d="M18 52H242" stroke="${ink}"/><g fill="${ink}" font-family="Arial" font-weight="700" font-size="43" letter-spacing="-2"><text x="18" y="108">SLOW</text><text x="18" y="150">ROOM</text><text x="18" y="212">SOFT</text><text x="18" y="254">NOISE</text></g><circle cx="221" cy="289" r="13" fill="#3658d9"/><text x="18" y="292" fill="${ink}" font-family="Arial" font-size="10">21 NOV / 19:00 / STUDIO 04</text>`));
await save('ticket.svg', svg(520, 160, `<rect width="520" height="160" fill="#E7DB8C"/><path d="M388 0V160" stroke="${ink}" stroke-dasharray="5 5"/><text x="20" y="30" fill="${ink}" font-family="Arial" font-size="10" letter-spacing="2">SLOW SIGNAL / ADMIT ONE</text><text x="18" y="85" fill="${ink}" font-family="Arial" font-weight="800" font-size="49" letter-spacing="-2">LISTEN CLOSE.</text><text x="20" y="129" fill="${ink}" font-family="Arial" font-size="12">STUDIO 04</text><text x="267" y="129" fill="${ink}" font-family="Arial" font-size="12">21.11.2026</text><text transform="translate(438 130) rotate(-90)" fill="${ink}" font-family="Arial" font-size="21" letter-spacing="2">NO. 0042</text>`));
await save('palette-study.svg', svg(340, 200, `<rect width="340" height="200" fill="${paper}"/><g filter="url(#grain)"><circle cx="87" cy="90" r="64" fill="#3658D9"/><circle cx="174" cy="112" r="64" fill="#C3D3ED"/><circle cx="252" cy="84" r="52" fill="#E7DB8C"/></g><text x="16" y="184" fill="${ink}" font-family="Arial" font-size="10" letter-spacing="2">LIGHT / PAPER / AFTERIMAGE</text>`));

function wave(name, mode) {
  const sampleRate = 24000, seconds = mode === 1 ? 12 : 9, frames = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(frames * 2, 40);
  const peaks = Array(72).fill(0);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate, edge = Math.min(1, t / .8, (seconds - t) / 1.5);
    let v = 0;
    if (mode === 1) {
      for (const [f,a] of [[130.81,.21],[196,.13],[261.63,.075],[392,.05]]) v += Math.sin(2*Math.PI*f*t + .6*Math.sin(t*.67+f)) * a * (.68 + .32*Math.sin(t*.5+f));
      const bell = t % 3; v += Math.sin(t*2*Math.PI*784) * Math.exp(-bell*3)*.11;
    } else {
      const pulse = t % .75, env = Math.exp(-pulse*27), chirp = 360 + 700*Math.exp(-pulse*40);
      v = Math.sin(2*Math.PI*chirp*t)*env*.3 + Math.sin(t*2*Math.PI*98)*.10*(.6+.4*Math.sin(t*.9)) + Math.sin(t*2*Math.PI*147)*.07;
    }
    v *= edge; buffer.writeInt16LE(Math.max(-32767,Math.min(32767,Math.round(v*32767))),44+i*2); const bin=Math.min(71,Math.floor(i/frames*72)); peaks[bin]=Math.max(peaks[bin],Math.abs(v));
  }
  return { buffer, seconds, peaks };
}
const sounds = {};
for (const [name,mode] of [['Afterimage',1],['Small-hours',2]]) { const audio=wave(name,mode); await save(`${name}.wav`,audio.buffer); sounds[name]={seconds:audio.seconds,peaks:audio.peaks}; }
await save('audio-waveforms.json', JSON.stringify(sounds, null, 2));

async function add(key, file, x, y, width, height, mime) {
  const asset = await command('asset','import','--file',join(content,file),'--allow-directory',content,...(mime?['--mime',mime]:[]));
  imported[key]=asset;
  objects.push({key,assetId:asset.id,x,y,width,height,file,mime:asset.mime});
}
await add('wordmark','wordmark.svg',0,0,405,121);
await add('signal','signal-study.svg',28,430,238,153);
await add('lineup','lineup.svg',1088,300,174,221);
await add('ticket','ticket.svg',285,503,280,86);
await add('palette','palette-study.svg',1130,25,204,120);
await add('brief','creative-brief.md',724,360,286,260);
await add('direction','art-direction.note',450,317,207,144,'text/x-acanvas-note');
await add('listening','listening.note',1024,172,221,113,'text/x-acanvas-note');
await add('next','next-pass.note',556,501,150,120,'text/x-acanvas-note');
await add('afterimage','Afterimage.wav',715,189,302,122);
await add('smallhours','Small-hours.wav',1040,556,300,100);
const bundle=await command('asset','import','--file',join(content,'activity/index.html'),'--bundle-root',join(content,'activity'));
imported.activity={id:bundle.assetId??bundle.id};
objects.push({key:'activity',assetId:bundle.assetId??bundle.id,x:714,y:-10,width:327,height:411,file:'activity/index.html',mime:'text/html'});
await command('board','operations','--input',await json('create-objects.json',{operations:objects.map(({assetId,x,y,width,height})=>({type:'create',object:{assetId,x,y,width,height}}))}));
let state=await command('session','read');
for(const object of objects)Object.assign(object,state.objects.find(row=>row.assetId===object.assetId));
const updates=[['direction','mist'],['listening','sand'],['next','blush']].map(([key,fill])=>({type:'update',objectId:objects.find(o=>o.key===key).id,expectedVersion:1,changes:{fill}}));
await command('board','operations','--input',await json('note-colors.json',{operations:updates}));
await json('demo-base.json',{project,session,objects,imported,sounds});
console.log(JSON.stringify({project,session,objects:objects.length,htmlAsset:imported.activity,audio:sounds}));
