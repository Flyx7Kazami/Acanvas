import { readFileSync } from 'node:fs';
export const manualLayout = JSON.parse(readFileSync(new URL('./manual-layout.json', import.meta.url), 'utf8'));
export const geometricLayout = Object.fromEntries(manualLayout.objects.filter(object => !object.key.startsWith('folder-art-')).map(object => [object.key, [object.x, object.y, object.width, object.height]]));
const manualFolder = manualLayout.groups.find(group => group.key === 'folder');
export const geometricFolder = { x: manualFolder.x, y: manualFolder.y };

export function geometricView(viewport) {
  const folderIds = new Set(manualLayout.groups.filter(group => group.mode === 'folder').map(group => group.sourceGroupId));
  const bounds = [...manualLayout.objects.filter(object => !folderIds.has(object.sourceGroupId)).map(object => ({ ...object, height: object.height + 32 })), ...manualLayout.groups.map(group => group.mode === 'folder' ? { x: group.x, y: group.y, width: 216, height: 256 } : group)];
  const minX = Math.min(...bounds.map(bounds => bounds.x)), minY = Math.min(...bounds.map(bounds => bounds.y));
  const maxX = Math.max(...bounds.map(bounds => bounds.x + bounds.width)), maxY = Math.max(...bounds.map(bounds => bounds.y + bounds.height));
  const zoom = Math.floor(Math.min((viewport.width - 104) / (maxX - minX), (viewport.height - 212) / (maxY - minY)) * 100) / 100;
  return { x: 80 - minX * zoom, y: 82 - minY * zoom, zoom, selectedObjectIds: [] };
}

export function projectGeometricLayout(state, ids, fixtureGroups, viewport, view) {
  const rect = bounds => ({ x: view.x + bounds.x * view.zoom, y: view.y + bounds.y * view.zoom, width: bounds.width * view.zoom, height: bounds.height * view.zoom });
  const projected = Object.keys(geometricLayout).map(key => {
    const object = state.objects.find(object => object.id === ids[key]);
    return { key, objectId: object.id, groupId: object.groupId, body: rect(object), caption: rect({ x: object.x, y: object.y + object.height + 10, width: object.width, height: 22 }) };
  });
  const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const boxes = projected.flatMap(object => ['body', 'caption'].map(kind => ({ key: object.key, objectId: object.objectId, groupId: object.groupId, kind, ...object[kind] })));
  const collisions = [];
  for (let first = 0; first < boxes.length; first++) for (let second = first + 1; second < boxes.length; second++) {
    if (boxes[first].objectId !== boxes[second].objectId && overlap(boxes[first], boxes[second])) collisions.push([boxes[first].key, boxes[first].kind, boxes[second].key, boxes[second].kind]);
  }
  const groups = Object.entries(fixtureGroups).map(([key, id]) => ({ key, ...state.groups.find(group => group.id === id) }));
  const sections = groups.map(group => ({ key: group.key, groupId: group.id, body: rect(group.mode === 'folder' ? { x: group.x, y: group.y, width: 216, height: 256 } : group) }));
  const titles = groups.map(group => ({ key: `${group.key}-title`, body: rect(group.mode === 'folder' ? { x: group.x, y: group.y + 237, width: 216, height: 15 } : { x: group.x + 12, y: group.y + 6, width: group.width - 24, height: 27 }) }));
  for (const box of boxes) {
    for (const section of sections) if (section.groupId !== box.groupId && overlap(box, section.body)) collisions.push([box.key, box.kind, section.key]);
    for (const title of titles) if (overlap(box, title.body)) collisions.push([box.key, box.kind, title.key]);
  }
  const controls = [
    { key: 'toolbar', x: 16, y: (viewport.height - 367) / 2, width: 40, height: 367 },
    { key: 'brand', x: 16, y: 16, width: 183, height: 38 },
    { key: 'collapsed-queue', x: (viewport.width - 688) / 2, y: viewport.height - 106, width: 688, height: 56 },
  ];
  const controlCollisions = [];
  for (const box of [...boxes, ...sections.map(section => ({ key: section.key, ...section.body }))]) for (const control of controls) {
    if (overlap(box, control)) controlCollisions.push([box.key, control.key]);
  }
  return { method: 'User-authored layout copied through CLI, projected with production bounds; rendered inspection follows in the Codex window.', queuePresentation: 'collapsed', viewport, suggestedView: view, actualSavedView: state.session.view, projected, sections, titles, controls, collisions, controlCollisions, contentBottom: Math.max(...boxes.map(box => box.y + box.height)), expectedCollapsedQueueTop: viewport.height - 106, toolbarRight: 56, leftmostObject: Math.min(...projected.map(object => object.body.x)) };
}
