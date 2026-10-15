import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioCanvasPlayer } from './AudioCanvasPlayer';
import { DominoLoader } from './DominoLoader';
import { resolveContentKind } from '../shared/content-types';
import type { Asset } from '../shared/types';
import { readThemePreference, themeFromPreference } from './theme';
import './audio-review.css';

function Preview() {
  const [assets, setAssets] = useState<Asset[]>([]), [selected, setSelected] = useState(''), [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  const src = selected ? `/api/assets/${encodeURIComponent(selected)}/content` : undefined;
  useEffect(() => {
    const applyTheme = () => { document.documentElement.dataset.theme = themeFromPreference(readThemePreference()); };
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    applyTheme(); query.addEventListener('change', applyTheme); window.addEventListener('storage', applyTheme);
    return () => { query.removeEventListener('change', applyTheme); window.removeEventListener('storage', applyTheme); };
  }, []);
  useEffect(() => { void (async () => {
    try {
      const session = new URLSearchParams(location.search).get('session');
      if (!session) throw new Error('Open this preview with a board session.');
      const bootstrap = await fetch('/api/bootstrap'); if (!bootstrap.ok) throw new Error('The local board is unavailable.');
      const response = await fetch(`/api/state?sessionId=${encodeURIComponent(session)}`); if (!response.ok) throw new Error('The board is unavailable.');
      const state = await response.json(), list: Asset[] = state.assets.filter((asset: Asset) => resolveContentKind(asset) === 'audio');
      setAssets(list); setSelected((list.find(asset => asset.name.includes('All Nighter')) || list[0])?.id || '');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to open audio.'); }
    finally { setLoaded(true); }
  })(); }, []);
  const asset = assets.find(value => value.id === selected);
  return <main className="audio-review-page"><div className="audio-review-stage">
    {asset && src ? <div className="audio-review-player"><AudioCanvasPlayer key={asset.id} src={src} title={asset.name} assetId={asset.id}/></div> : !loaded ? <div className="audio-review-loading" role="status"><DominoLoader/><span>Loading audio…</span></div> : <p>{error || (assets.length ? 'Choose an audio file' : 'No audio files yet')}</p>}
    {!!assets.length && <select className="audio-review-source" aria-label="Audio file" value={selected} onChange={event => setSelected(event.target.value)}><option value="">Choose audio…</option>{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select>}
  </div></main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
