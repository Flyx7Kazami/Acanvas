import { useEffect, useState } from 'react';
import type { Asset, BoardGroup, BoardObject, GroupColor } from '../shared/types';
import { resolveContentKind } from '../shared/content-types';
import { AssetThumb } from './ContentRenderer';
import type { BoardApi } from './api';

export const folderPalettes: Record<GroupColor, [string, string, string]> = {
  cobalt: ['#315AD9', '#2648AF', '#F3EBDD'], sage: ['#779D85', '#60816C', '#F3EBDD'],
  coral: ['#EA6848', '#C3573D', '#F3EBDD'], lilac: ['#ADA0DE', '#8C7EBC', '#F3EBDD'],
  ink: ['#202124', '#34363A', '#F3EBDD'], sand: ['#E7D9B7', '#CDBC91', '#635F50'],
};
export const folderBack = 'M7 44Q7 32 19 32H69L80 23H197Q209 23 209 35V210Q209 222 197 222H19Q7 222 7 210Z';
export const folderFront = 'M0 77Q0 64 13 64H62Q69 64 76 73L83 82H203Q216 82 216 95V211Q216 224 203 224H13Q0 224 0 211Z';
export const folderLinePositions = [104, 106, 108, 110, 112, 115, 119, 124, 130, 137, 145, 154, 164, 175];
function FolderPreview({ object, asset, api }: { object: BoardObject; asset?: Asset; api: BoardApi }) {
  const kind = resolveContentKind(asset), [text, setText] = useState('');
  useEffect(() => {
    if (!asset || !['note', 'markdown'].includes(kind)) return;
    let live = true;
    void fetch(api.content(asset.id)).then(response => response.ok ? response.text() : '').then(value => { if (live) setText(value.slice(0, 140)); }).catch(() => undefined);
    return () => { live = false; };
  }, [asset?.id, object.updatedAt, kind, api]);
  return <span className={`folder-preview-card folder-preview-${kind}`} data-preview-object={object.id} data-preview-text={text || asset?.name || 'File'}>
    {kind === 'note' || kind === 'markdown' ? <><small>{kind === 'note' ? 'NOTE' : 'TEXT'}</small><span>{text || asset?.name || 'Note'}</span></> : <><AssetThumb asset={asset} src={api.content(object.assetId)}/>{!['image', 'video'].includes(kind) && <span>{asset?.name || 'File'}</span>}</>}
  </span>;
}
export function GroupFolder({ group, objects, assets, api }: { group: BoardGroup; objects: BoardObject[]; assets: Asset[]; api: BoardApi }) {
  const colors = folderPalettes[group.color], members = group.objectIds.flatMap(id => { const object = objects.find(item => item.id === id); return object ? [object] : []; }).slice(0, 3);
  return <><svg className="folder-back" viewBox="0 0 216 224" aria-hidden="true"><path d={folderBack} fill={colors[1]}/></svg>
    <span className="folder-previews">{members.map(object => <FolderPreview key={object.id} object={object} asset={assets.find(asset => asset.id === object.assetId)} api={api}/>)}</span>
    <svg className="folder-front" viewBox="0 0 216 224" aria-hidden="true"><path d={folderFront} fill={colors[0]}/><g fill="none" stroke={colors[2]} strokeWidth="1.2">{folderLinePositions.map(y => <path key={y} d={`M22 ${y}H107`}/>)}<path d="M145 109H194M145 169H194"/></g><g fill={colors[2]} fontFamily="inherit"><text x="145" y="145" fontSize="28" fontWeight="500">{String(group.objectIds.length).padStart(2, '0')}</text><text x="145" y="158" fontSize="7" letterSpacing="1.3">ITEMS</text></g></svg>
    </>;
}
