import { History, X } from 'lucide-react';
import type { Asset, BoardObject, Draft, Task } from '../shared/types';
import { AssetThumb } from './ContentRenderer';

export type ReferenceIdentity = { kind: 'object' | 'task'; id: string };
export function referenceOrder(references: Draft['references']): ReferenceIdentity[] {
  return (references as Draft['references'] & { order?: ReferenceIdentity[] }).order || [
    ...references.objectIds.map(id => ({ kind: 'object' as const, id })),
    ...references.taskIds.map(id => ({ kind: 'task' as const, id })),
  ];
}

export function addReferences(references: Draft['references'], entries: ReferenceIdentity[]): Draft['references'] {
  const order = [...referenceOrder(references)];
  for (const entry of entries) if (!order.some(value => value.kind === entry.kind && value.id === entry.id)) order.push(entry);
  return { objectIds: order.filter(entry => entry.kind === 'object').map(entry => entry.id), taskIds: order.filter(entry => entry.kind === 'task').map(entry => entry.id), order };
}

export function removeReference(references: Draft['references'], entry: ReferenceIdentity): Draft['references'] {
  const order = referenceOrder(references).filter(value => value.kind !== entry.kind || value.id !== entry.id);
  return { objectIds: order.filter(value => value.kind === 'object').map(value => value.id), taskIds: order.filter(value => value.kind === 'task').map(value => value.id), order };
}

export function ChatboxReferences({ draft, preview, objects, assets, tasks, content, disabled, onConfirm, onDismiss, onRemove }: {
  draft: Draft; preview: string[]; objects: BoardObject[]; assets: Asset[]; tasks: Task[]; content: (id: string) => string;
  disabled: boolean; onConfirm: () => void; onDismiss: () => void; onRemove: (entry: ReferenceIdentity) => void;
}) {
  const order = referenceOrder(draft.references);
  if (!order.length && !preview.length) return null;
  const source = tasks.find(task => task.id === draft.editingTaskId)?.snapshot.referenceContent;
  return <div className="chatbox-references" aria-label="Request references">
    {order.map(entry => {
      const object = objects.find(value => value.id === entry.id) || source?.objects.find(value => value.id === entry.id);
      const asset = [...assets, ...(source?.assets || [])].find(value => value.id === object?.assetId);
      const task = tasks.find(value => value.id === entry.id);
      const name = entry.kind === 'object' ? asset?.name || 'Removed object' : task ? `Request ${task.sequence}` : 'Historical request';
      return <div className="chatbox-reference" key={`${entry.kind}:${entry.id}`} data-reference-kind={entry.kind} data-reference-id={entry.id} data-reference-unavailable={entry.kind === 'object' && !object || undefined}>
        {entry.kind === 'object' ? <AssetThumb asset={asset} src={asset ? content(asset.id) : ''}/> : <History size={14}/>}
        <span title={name}>@{name}</span><button type="button" aria-label={`Remove reference ${name}`} disabled={disabled} onClick={() => onRemove(entry)}><X size={13}/></button>
      </div>;
    })}
    {!!preview.length && <div className="chatbox-reference-preview" data-reference-preview>
      <button type="button" className="reference-preview-confirm" aria-label={`Add ${preview.length} selected ${preview.length === 1 ? 'object' : 'objects'} to request`} disabled={disabled} onClick={onConfirm}>
        <span className="reference-preview-thumbs">{preview.slice(0, 3).map(id => { const object = objects.find(value => value.id === id), asset = assets.find(value => value.id === object?.assetId); return <AssetThumb key={id} asset={asset} src={asset ? content(asset.id) : ''}/>; })}</span>
        <span>{preview.length === 1 ? assets.find(asset => asset.id === objects.find(object => object.id === preview[0])?.assetId)?.name || 'Selected object' : `${preview.length} selected objects`}</span>
      </button><button type="button" aria-label="Dismiss selected reference preview" disabled={disabled} onClick={onDismiss}><X size={13}/></button>
    </div>}
  </div>;
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
