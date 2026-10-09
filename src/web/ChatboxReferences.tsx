import { History, X } from 'lucide-react';
import type { Asset, BoardObject, Draft, RequestReference, Task } from '../shared/types';
import { AssetThumb } from './ContentRenderer';

export type ReferenceIdentity = RequestReference;

export function ChatboxReference({ entry, draft, preview = false, objects, assets, tasks, content, disabled, onConfirm, onRemove }: {
  entry: ReferenceIdentity; draft: Draft; preview?: boolean; objects: BoardObject[]; assets: Asset[]; tasks: Task[]; content: (id: string) => string;
  disabled: boolean; onConfirm: () => void; onRemove: () => void;
}) {
  const source = tasks.find(task => task.id === draft.editingTaskId)?.snapshot.referenceContent;
  const object = objects.find(value => value.id === entry.id) || source?.objects.find(value => value.id === entry.id);
  const asset = [...assets, ...(source?.assets || [])].find(value => value.id === object?.assetId);
  const task = tasks.find(value => value.id === entry.id);
  const name = entry.kind === 'object' ? asset?.name || 'Removed object' : task ? `Request ${task.sequence}` : 'Historical request';
  return <span className={preview ? 'chatbox-reference-preview' : 'chatbox-reference'} data-reference-preview={preview || undefined} data-reference-kind={entry.kind} data-reference-id={entry.id} data-reference-unavailable={entry.kind === 'object' && !object || undefined}>
    {preview ? <button type="button" className="reference-preview-confirm" aria-label={`Add selected ${name} to request`} disabled={disabled} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={onConfirm}><AssetThumb asset={asset} src={asset ? content(asset.id) : ''}/><span title={name}>{name}</span></button> : <>{entry.kind === 'object' ? <AssetThumb asset={asset} src={asset ? content(asset.id) : ''}/> : <History size={14}/>}<span title={name}>{name}</span></>}
    <button type="button" aria-label={preview ? `Dismiss selected reference preview ${name}` : `Remove reference ${name}`} disabled={disabled} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={onRemove}><X size={13}/></button>
  </span>;
}

export type ReferenceCandidate = ReferenceIdentity & { name: string; subtitle: string; asset?: Asset };
export function referenceCandidates(objects: BoardObject[], assets: Asset[], tasks: Task[], sessionId: string, query: string): ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [
    ...objects.map((object, index) => { const asset = assets.find(value => value.id === object.assetId); return { kind: 'object' as const, id: object.id, name: asset?.name || 'File', subtitle: `Canvas object ${index + 1}`, asset }; }),
    ...tasks.filter(task => task.sessionId === sessionId).map(task => ({ kind: 'task' as const, id: task.id, name: `Request ${task.sequence}`, subtitle: task.snapshot.userRequest.text || 'References and annotations' })),
  ];
  const needle = query.trim().toLocaleLowerCase();
  return candidates.filter(value => !needle || `${value.name} ${value.subtitle}`.toLocaleLowerCase().includes(needle)).slice(0, 30);
}

export function ReferenceSearch({ candidates, selected, content, onSelect, onHover }: { candidates: ReferenceCandidate[]; selected: number; content: (id: string) => string; onSelect: (entry: ReferenceCandidate) => void; onHover: (index: number) => void }) {
  return <div className="reference-search" id="reference-search" role="listbox" aria-label="Choose a reference">
    {candidates.length ? candidates.map((entry, index) => <button type="button" role="option" aria-selected={index === selected} id={`reference-option-${index}`} key={`${entry.kind}:${entry.id}`} onPointerDown={event => event.preventDefault()} onPointerMove={() => onHover(index)} onClick={() => onSelect(entry)}>
      {entry.asset ? <AssetThumb asset={entry.asset} src={content(entry.asset.id)}/> : <History size={16}/>}
      <span><strong>{entry.name}</strong><small>{entry.subtitle}</small></span>
    </button>) : <p>No matching references</p>}
  </div>;
}
