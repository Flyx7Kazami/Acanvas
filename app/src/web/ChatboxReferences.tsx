import { History, X } from 'lucide-react';
import type { Asset, BoardGroup, BoardObject, Draft, GroupColor, RequestReference, Task } from '../shared/types';
import { AssetThumb } from './ContentRenderer';
import { folderPalettes } from './GroupFolder';

export function GroupReferenceIcon({ color }: { color?: GroupColor }) {
  return <svg className="group-reference-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" style={{ flex: '0 0 auto' }} fill={color ? folderPalettes[color][0] : 'currentColor'} stroke={color === 'ink' ? 'var(--muted)' : 'none'} strokeWidth={1}><path d="M4 4h5.2a2 2 0 0 1 1.4.6L13 7h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>;
}

export type ReferenceIdentity = RequestReference;

export function ChatboxReference({ entry, draft, preview = false, groups, objects, assets, tasks, content, disabled, onConfirm, onRemove }: {
  entry: ReferenceIdentity; draft: Draft; preview?: boolean; groups: BoardGroup[]; objects: BoardObject[]; assets: Asset[]; tasks: Task[]; content: (id: string) => string;
  disabled: boolean; onConfirm: () => void; onRemove: () => void;
}) {
  const source = tasks.find(task => task.id === draft.editingTaskId)?.snapshot.referenceContent;
  const object = objects.find(value => value.id === entry.id) || source?.objects.find(value => value.id === entry.id);
  const asset = [...assets, ...(source?.assets || [])].find(value => value.id === object?.assetId);
  const group = source?.groups?.find(value => value.id === entry.id) || groups.find(value => value.id === entry.id);
  const task = tasks.find(value => value.id === entry.id);
  const name = entry.kind === 'object' ? asset?.name || 'Removed object' : entry.kind === 'group' ? group?.name || 'Removed group' : task ? `Request ${task.sequence}` : 'Historical request';
  return <span className={preview ? 'chatbox-reference-preview' : 'chatbox-reference'} data-reference-preview={preview || undefined} data-reference-kind={entry.kind} data-reference-id={entry.id} data-reference-unavailable={(entry.kind === 'object' && !object || entry.kind === 'group' && !group) || undefined} data-reference-disabled={disabled || undefined}>
    <span className={`reference-content${preview ? ' reference-preview-confirm' : ''}`} role={preview ? 'button' : undefined} aria-label={preview ? `Add selected ${name} to request` : undefined} aria-disabled={preview && disabled || undefined} tabIndex={preview ? 0 : undefined} onPointerDown={preview ? event => { event.preventDefault(); event.stopPropagation(); } : undefined} onClick={preview && !disabled ? onConfirm : undefined} onKeyDown={preview ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (!disabled) onConfirm(); } } : undefined}>{entry.kind === 'object' ? <AssetThumb asset={asset} src={asset ? content(asset.id) : ''}/> : entry.kind === 'group' ? <GroupReferenceIcon color={group?.color}/> : <History size={14}/>}<span className="reference-label" title={name}>{name}</span></span>
    <button type="button" className="reference-remove" aria-label={preview ? `Dismiss selected reference preview ${name}` : `Remove reference ${name}`} disabled={disabled} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={onRemove}><X size={13}/></button>
  </span>;
}

export type ReferenceCandidate = ReferenceIdentity & { name: string; subtitle: string; asset?: Asset; color?: GroupColor };
export function referenceCandidates(objects: BoardObject[], groups: BoardGroup[], assets: Asset[], tasks: Task[], sessionId: string, query: string): ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [
    ...groups.map(group => ({ kind: 'group' as const, id: group.id, name: group.name, subtitle: 'Canvas group', color: group.color })),
    ...objects.map((object, index) => { const asset = assets.find(value => value.id === object.assetId); return { kind: 'object' as const, id: object.id, name: asset?.name || 'File', subtitle: `Canvas object ${index + 1}`, asset }; }),
    ...tasks.filter(task => task.sessionId === sessionId).map(task => ({ kind: 'task' as const, id: task.id, name: `Request ${task.sequence}`, subtitle: task.snapshot.userRequest.text || 'References and annotations' })),
  ];
  const needle = query.trim().toLocaleLowerCase();
  return candidates.filter(value => !needle || `${value.name} ${value.subtitle}`.toLocaleLowerCase().includes(needle)).slice(0, 30);
}

export function ReferenceSearch({ candidates, selected, content, onSelect, onHover }: { candidates: ReferenceCandidate[]; selected: number; content: (id: string) => string; onSelect: (entry: ReferenceCandidate) => void; onHover: (index: number) => void }) {
  return <div className="reference-search" id="reference-search" role="listbox" aria-label="Choose a reference">
    {candidates.length ? candidates.map((entry, index) => <button type="button" role="option" aria-selected={index === selected} id={`reference-option-${index}`} key={`${entry.kind}:${entry.id}`} onPointerDown={event => event.preventDefault()} onPointerMove={() => onHover(index)} onClick={() => onSelect(entry)}>
      {entry.asset ? <AssetThumb asset={entry.asset} src={content(entry.asset.id)}/> : entry.kind === 'group' ? <GroupReferenceIcon color={entry.color}/> : <History size={16}/>}
      <span><strong>{entry.name}</strong><small>{entry.subtitle}</small></span>
    </button>) : <p>No matching references</p>}
  </div>;
}
