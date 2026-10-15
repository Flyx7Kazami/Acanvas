import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Asset, BoardGroup, BoardObject, GroupColor } from '../shared/types';
import { resolveContentKind } from '../shared/content-types';
import { AssetThumb } from './ContentRenderer';
import type { BoardApi } from './api';

export const folderPalettes: Record<GroupColor, [string, string, string]> = {
  cobalt: ['#315AD9', '#2648AF', '#F3EBDD'], sage: ['#779D85', '#60816C', '#F3EBDD'],
  coral: ['#EA6848', '#C3573D', '#F3EBDD'], lilac: ['#ADA0DE', '#8C7EBC', '#F3EBDD'],
  ink: ['#202124', '#34363A', '#F3EBDD'], sand: ['#E7D9B7', '#CDBC91', '#635F50'],
};
export const folderBack = 'M7 52Q7 48 11 48H69L80 39H205Q209 39 209 43V218Q209 222 205 222H11Q7 222 7 218Z';
export const folderFront = 'M0 68Q0 64 4 64H62Q66 64 69 68L80 80Q82 82 85 82H212Q216 82 216 86V220Q216 224 212 224H4Q0 224 0 220Z';
export const folderLinePositions = [102, 104, 106, 108, 110, 113, 117, 122, 128, 135, 143, 152, 162, 173, 185, 198, 212];

/** Folder text uses the displayed font and available column width. */
function folderTextLines(text: string, width: number, measure: (value: string) => number, limit: number, ellipsis: boolean): string[] {
  const remaining = Array.from(text), lines: string[] = [];
  while (remaining.length && lines.length < limit) {
    let length = 0;
    while (length < remaining.length && remaining[length] !== '\n' && measure(remaining.slice(0, length + 1).join('')) <= width) length++;
    if (length === 0 && remaining[0] !== '\n') length = 1;
    const complete = length === remaining.length, newline = remaining[length] === '\n';
    if (lines.length === limit - 1 && !complete && ellipsis) {
      let last = remaining.join('').replace(/\n/g, ' ');
      while (last && measure(last + '…') > width) last = Array.from(last).slice(0, -1).join('');
      lines.push(last.trimEnd() + '…'); break;
    }
    if (!complete && !newline) {
      const wordBreak = remaining.slice(0, length).lastIndexOf(' ');
      if (wordBreak > 0) length = wordBreak;
    }
    lines.push(remaining.splice(0, length).join('').trimEnd());
    if (remaining[0] === '\n') remaining.shift();
    else while (remaining[0] === ' ') remaining.shift();
  }
  return lines.length ? lines : [''];
}

function FolderText({ text, className, lines = 2, ellipsis = true }: { text: string; className: string; lines?: number; ellipsis?: boolean }) {
  const element = useRef<HTMLSpanElement>(null), [shown, setShown] = useState<string[]>([text]);
  useLayoutEffect(() => {
    let active = true; const node = element.current;
    if (!node) return;
    const measure = document.createElement('canvas').getContext('2d')!;
    const update = () => {
      if (!active) return;
      const style = getComputedStyle(node); measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const next = folderTextLines(text, node.clientWidth, value => measure.measureText(value).width, lines, ellipsis);
      setShown(current => current.join('\n') === next.join('\n') ? current : next);
    };
    update(); void document.fonts.ready.then(update);
    const observer = new ResizeObserver(update); observer.observe(node);
    return () => { active = false; observer.disconnect(); };
  }, [text, lines, ellipsis]);
  return <span ref={element} className={className} title={text}>{shown.map((line, index) => <span className="folder-text-line" key={index}>{line || '\u200b'}</span>)}</span>;
}

function FolderPreview({ object, asset, api }: { object: BoardObject; asset?: Asset; api: BoardApi }) {
  const kind = resolveContentKind(asset), [text, setText] = useState('');
  useEffect(() => {
    if (!asset || !['note', 'markdown'].includes(kind)) return;
    let live = true;
    void fetch(api.content(asset.id)).then(response => response.ok ? response.text() : '').then(value => { if (live) setText(value.slice(0, 140)); }).catch(() => undefined);
    return () => { live = false; };
  }, [asset?.id, object.updatedAt, kind, api]);
  return <span className={`folder-preview-card folder-preview-${kind}`} data-preview-object={object.id}>
    {kind === 'note' || kind === 'markdown' ? <><small className="folder-preview-kind">{kind === 'note' ? 'NOTE' : 'TEXT'}</small><FolderText className="folder-preview-copy" text={text || asset?.name || 'Note'} lines={5} ellipsis={false}/></> : <><AssetThumb asset={asset} src={api.content(object.assetId)}/>{!['image', 'video'].includes(kind) && <FolderText className="folder-preview-copy" text={asset?.name || 'File'} lines={3}/>}</>}
  </span>;
}

export function GroupFolder({ group, objects, assets, api }: { group: BoardGroup; objects: BoardObject[]; assets: Asset[]; api: BoardApi }) {
  const colors = folderPalettes[group.color], members = group.objectIds.flatMap(id => { const object = objects.find(item => item.id === id); return object ? [object] : []; }).slice(0, 3);
  return <span className="folder-art">
    <svg className="folder-back" viewBox="0 0 216 224" aria-hidden="true"><path d={folderBack} fill={colors[1]}/></svg>
    <span className="folder-previews">{members.map(object => <FolderPreview key={object.id} object={object} asset={assets.find(asset => asset.id === object.assetId)} api={api}/>)}</span>
    <span className="folder-front" style={{ color: colors[2] }}>
      <svg className="folder-cover-svg" viewBox="0 0 216 224" aria-hidden="true"><path d={folderFront} fill={colors[0]}/><g fill="none" stroke={colors[2]} strokeWidth="1" transform="translate(0 .5)">{folderLinePositions.map(y => <path key={y} d={`M14 ${y}H108`}/>)}<path d="M138 102H202M138 152H202M138 212H202"/></g></svg>
      <FolderText className="folder-face-name" text={group.name}/>
      <FolderText className="folder-face-count" text={`${group.objectIds.length} ${group.objectIds.length === 1 ? 'item' : 'items'}`} lines={1}/>
    </span>
  </span>;
}
