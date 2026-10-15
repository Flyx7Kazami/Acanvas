import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioCanvasPlayer } from '../../../src/web/AudioCanvasPlayer';
import { MarkdownCanvasContent } from '../../../src/web/MarkdownCanvasContent';
import { SceneGifContent, SceneVideoContent } from '../../../src/web/scene-renderer/media';
import { SceneContentContext, SceneContentRegistry } from '../../../src/web/scene-renderer/content';
import { requestedMarkdownAnchor } from '../../../src/web/annotation-scene';
import '../../../src/web/content.css';

document.head.insertAdjacentHTML('beforeend', '<style>:root{--surface:#fff;--ink:#222;--muted:#666;--canvas:#f0f0f0;--edge:#ddd;--hover:#eee;font:14px Arial,sans-serif}:root[data-theme=dark]{--surface:#252525;--ink:#eee;--muted:#aaa;--canvas:#191919;--edge:#444;--hover:#333}*{box-sizing:border-box}body{margin:16px}.tile{position:relative}.semantic{position:absolute;inset:0;opacity:0}.semantic>div,.semantic>video,.semantic>canvas{width:100%;height:100%}.visible{position:absolute;inset:0;pointer-events:none}</style>');
const registry = new SceneContentRegistry();
let presented, last;
const measurements = [];
function App() {
  const initial = new URLSearchParams(location.search).get('kind') || 'audio';
  const [kind, setKind] = useState(initial), [size, setSize] = useState(initial === 'video' || initial === 'markdown' ? { width: 320, height: 240 } : { width: 520, height: 88 }), [videoSrc, setVideoSrc] = useState('/lab/video.mp4'), canvas = useRef(null), tile = useRef(null);
  useEffect(() => {
    let pending = 0;
    const paint = () => {
      const frame = registry.get(kind), output = canvas.current, panel = tile.current; if (!output || !panel) return;
      const width = panel.clientWidth, height = panel.clientHeight, ratio = devicePixelRatio;
      output.width = Math.round(width * ratio); output.height = Math.round(height * ratio); const context = output.getContext('2d'); context.scale(ratio, ratio); context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface'); context.fillRect(0, 0, width, height);
      if (frame) { const bitmap = frame.metadata.bitmap, contained = frame.metadata.fit === 'contain', scale = Math.min(width / bitmap.width, height / bitmap.height), w = contained ? bitmap.width * scale : width, h = contained ? bitmap.height * scale : height; frame.draw(context, { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h }); presented = structuredClone(frame.metadata); measurements.push({ kind, time: performance.now(), metadata: presented }); } else presented = undefined;
      last = output;
    };
    const unsubscribe = registry.subscribe(() => { if (!pending) pending = requestAnimationFrame(() => { pending = 0; paint(); }); }); paint();
    return () => { unsubscribe(); cancelAnimationFrame(pending); };
  }, [kind, size]);
  useEffect(() => { window.mediaLab = {
    set: (next, width = next === 'audio' ? 520 : 320, height = next === 'audio' ? 88 : 240) => { presented = undefined; setSize({ width, height }); setKind(next); },
    resize: (width, height) => setSize({ width, height }),
    videoSource: src => setVideoSrc(src),
    metadata: () => presented,
    sameTickMarkdown: () => {
      const before = structuredClone(presented), scroller = document.querySelector('.markdown-content'), text = document.querySelector('.markdown-body p').firstChild;
      scroller.scrollTop = 220; const range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 10); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const requested = requestedMarkdownAnchor('markdown'), copy = window.mediaLab.capture(); return Promise.resolve(copy).then(evidence => ({ before, requested, evidence }));
    },
    capture: async () => { if (!last || !presented) throw new Error('Wait for the displayed media frame.'); const copy = document.createElement('canvas'); copy.width = last.width; copy.height = last.height; copy.getContext('2d').drawImage(last, 0, 0); const metadata = structuredClone(presented), rgba = [...copy.getContext('2d').getImageData(0, 0, copy.width, copy.height).data]; const blob = await new Promise(resolve => copy.toBlob(value => resolve(value), 'image/png')); return { metadata, rgba, png: [...new Uint8Array(await blob.arrayBuffer())], width: copy.width, height: copy.height }; },
    measurements: () => measurements,
    armSound: () => document.addEventListener('click', () => { void window.mediaLab.sound(); }, { once: true }),
    sound: async () => { const element = document.querySelector('audio'); const audio = new AudioContext(), source = audio.createMediaElementSource(element), analyser = audio.createAnalyser(); source.connect(analyser); analyser.connect(audio.destination); await audio.resume(); window.soundProbe = { audio, analyser }; return audio.state; },
    pcm: () => { const probe = window.soundProbe, data = new Float32Array(2048); probe.analyser.getFloatTimeDomainData(data); return [...data]; },
  }; }, []);
  return <div ref={tile} className="tile" data-object-id={kind} style={{ width: size.width, height: size.height }}><canvas ref={canvas} className="visible" data-testid="visible"/><SceneContentContext.Provider value={{ registry, objectId: kind, width: size.width, height: size.height }}><div className="semantic">
    {kind === 'audio' ? <AudioCanvasPlayer src="/lab/audio/content" title="Avery - Night drive - 01 Ocean.wav" assetId="tone"/> : kind === 'markdown' ? <div className="content-shell"><MarkdownCanvasContent src="/lab/document.md" title="Notes"/><a className="markdown-download" href="/lab/document.md">↓</a></div> : kind === 'gif' ? <SceneGifContent src="/lab/reference.gif" title="Animation"/> : <SceneVideoContent src={videoSrc} title="Numbered video"/>}
  </div></SceneContentContext.Provider></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
