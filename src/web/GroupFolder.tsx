import { useEffect, useState } from 'react';
import type { Asset, BoardGroup, BoardObject, GroupTexture } from '../shared/types';
import { resolveContentKind } from '../shared/content-types';
import { AssetThumb } from './ContentRenderer';
import type { BoardApi } from './api';

export const folderPalettes: Record<GroupTexture, [string, string, string]> = {
  orbit: ['#315AD9', '#202124', '#F3EBDD'], grid: ['#779D85', '#202124', '#F3EBDD'],
  rays: ['#EA6848', '#202124', '#F3EBDD'], steps: ['#ADA0DE', '#315AD9', '#F3EBDD'],
  weave: ['#202124', '#779D85', '#F3EBDD'], confetti: ['#F3EBDD', '#EA6848', '#315AD9'],
};
export const folderBack = 'M9 47Q9 35 21 35H77L89 23H217Q231 23 231 37V165Q231 177 219 177H21Q9 177 9 165Z';
export const folderFront = 'M0 76Q0 64 12 64H66Q74 64 80 72L88 82H228Q240 82 240 94V168Q240 180 228 180H12Q0 180 0 168Z';
export function folderPattern(texture: GroupTexture): string[] {
  switch (texture) {
    case 'orbit': return ['M202 102A35 35 0 1 1 201.9 102M184 117A17 17 0 1 1 183.9 117', 'M23 115H80V123H23ZM23 131H59V139H23Z'];
    case 'grid': return ['M25 107H41V123H25ZM49 107H65V123H49ZM73 107H89V123H73ZM25 131H41V147H25ZM49 131H65V147H49ZM73 131H89V147H73Z', 'M149 103H213V111H149ZM149 123H195V131H149ZM149 143H213V151H149Z'];
    case 'rays': return ['M183 96L190 112L207 106L202 123L219 132L201 138L206 156L188 150L178 168L173 149L154 153L162 136L145 124L166 121L164 102L177 113Z', 'M23 108H82V115H23ZM23 124H64V131H23Z'];
    case 'steps': return ['M25 108H49V132H73V156H97V180H25Z', 'M130 100H151V121H172V142H193V163H214V180H193V163H172V142H151V121H130Z'];
    case 'weave': return ['M23 106H215V114H23ZM23 130H215V138H23ZM23 154H215V162H23Z', 'M49 97H57V173H49ZM97 97H105V173H97ZM145 97H153V173H145ZM193 97H201V173H193Z'];
    case 'confetti': return ['M28 113L49 103L58 123L37 133ZM173 139L202 127L211 148L182 160ZM96 146L117 141L122 162L101 167Z', 'M159 100L167 112L159 124L151 112ZM68 139L80 151L68 163L56 151ZM116 103H139V112H116Z'];
  }
}
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
  const colors = folderPalettes[group.texture], members = group.objectIds.flatMap(id => { const object = objects.find(item => item.id === id); return object ? [object] : []; }).slice(0, 3);
  return <><svg className="folder-back" viewBox="0 0 240 180" aria-hidden="true"><path d={folderBack} fill={colors[1]}/></svg>
    <span className="folder-previews">{members.map(object => <FolderPreview key={object.id} object={object} asset={assets.find(asset => asset.id === object.assetId)} api={api}/>)}</span>
    <svg className="folder-front" viewBox="0 0 240 180" aria-hidden="true"><path d={folderFront} fill={colors[0]}/>{folderPattern(group.texture).map((d, index) => <path key={index} d={d} fill={colors[index + 1]} fillRule="evenodd"/>)}</svg>
    <span className="folder-caption"><span>{group.name}</span><small>{group.objectIds.length} {group.objectIds.length === 1 ? 'item' : 'items'}</small></span></>;
}
