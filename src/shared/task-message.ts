import type { DraftReferences, RequestReference, ResolvedRequestReference, TaskSnapshot } from './types.js';

export function referenceOrder(references: DraftReferences, text?: string): RequestReference[] {
  const order: RequestReference[] = references.order ?? [...references.objectIds.map(id => ({ kind: 'object' as const, id })), ...references.taskIds.map(id => ({ kind: 'task' as const, id }))];
  return text === undefined ? order : order.map(reference => ({ ...reference, textOffset: reference.textOffset ?? text.length }));
}

export type ReferencePart<T extends RequestReference> = { kind: 'text'; text: string } | { kind: 'reference'; reference: T };

/** References use pure-text UTF-16 offsets; entries at the same offset retain their array order. */
export function referenceParts<T extends RequestReference>(text: string, order: readonly T[]): ReferencePart<T>[] {
  const parts: ReferencePart<T>[] = [];
  let cursor = 0;
  for (const reference of order) {
    const offset = reference.textOffset ?? text.length;
    if (offset > cursor) parts.push({ kind: 'text', text: text.slice(cursor, offset) });
    parts.push({ kind: 'reference', reference });
    cursor = offset;
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) });
  return parts;
}

export function snapshotReferences(snapshot: TaskSnapshot): (RequestReference | ResolvedRequestReference)[] {
  return snapshot.requestReferences?.order ?? referenceOrder({ objectIds: snapshot.requestReferences?.objectIds ?? snapshot.referenceContent.objects.map(object => object.id), taskIds: snapshot.requestReferences?.taskIds ?? snapshot.referenceContent.taskIds });
}

const encoded = (value: unknown) => JSON.stringify(value);

export function referenceLabel(snapshot: TaskSnapshot, reference: RequestReference | ResolvedRequestReference): string {
  if ('label' in reference) return reference.label;
  if (reference.kind === 'task') return `Request ${reference.id}`;
  const object = snapshot.referenceContent.objects.find(object => object.id === reference.id);
  return snapshot.referenceContent.assets.find(asset => asset.id === object?.assetId)?.name ?? reference.id;
}

/** The original request and comments are user input; imported material and scenes are reference evidence. */
export function generateRequirementText(snapshot: TaskSnapshot): string {
  const sections: string[] = [], references = snapshotReferences(snapshot);
  const requestText = referenceParts(snapshot.userRequest.text, references).map(part => part.kind === 'text' ? part.text : `[@${encoded(referenceLabel(snapshot, part.reference))} (reference_content; ${encoded({ kind: part.reference.kind, id: part.reference.id })})]`).join('');
  if (references.length) sections.push(`References (reference_content):\n${references.map((reference, index) => {
    if (reference.kind === 'object') {
      const object = 'object' in reference ? reference.object : snapshot.referenceContent.objects.find(object => object.id === reference.id);
      const asset = 'asset' in reference ? reference.asset : snapshot.referenceContent.assets.find(asset => asset.id === object?.assetId);
      return `${index + 1}. @${encoded('label' in reference ? reference.label : asset?.name ?? reference.id)} ${encoded({ kind: 'object', objectId: reference.id, assetId: object?.assetId, version: object?.version, bounds: object && { x: object.x, y: object.y, width: object.width, height: object.height }, sourceSessionId: 'sourceSessionId' in reference ? reference.sourceSessionId : undefined, sourceTaskId: object?.sourceTaskId, sourceRunId: object?.sourceRunId })}`;
    }
    return `${index + 1}. @${encoded('label' in reference ? reference.label : `Request ${reference.id}`)} ${encoded({ kind: 'task', taskId: reference.id, sourceSessionId: 'sourceSessionId' in reference ? reference.sourceSessionId : undefined, ...('task' in reference ? { sequence: reference.task.sequence, text: reference.task.text } : {}) })}`;
  }).join('\n')}`);
  const attachmentIds = snapshot.requestReferences?.attachmentIds ?? snapshot.referenceContent.assets.map(asset => asset.id);
  if (attachmentIds.length) sections.push(`Attachments (reference_content):\n${attachmentIds.map((id, index) => {
    const asset = snapshot.referenceContent.assets.find(asset => asset.id === id);
    return `${index + 1}. ${encoded({ assetId: id, name: asset?.name, mime: asset?.mime, sourceTaskId: asset?.sourceTaskId, sourceRunId: asset?.sourceRunId })}`;
  }).join('\n')}`);
  snapshot.annotations.forEach((annotation, index) => {
    const capture = annotation.capture;
    const lines = [`Annotation ${index + 1} (user_annotation):`, annotation.text,
      `Target: ${encoded({ scope: annotation.scope, objectId: annotation.objectId, objectIds: annotation.objectIds, assetId: annotation.assetId })}`,
      `Coordinates: ${encoded({ geometry: annotation.geometry ?? 'rect', coordinateSpace: annotation.coordinateSpace, bounds: annotation.bounds, contentAnchor: annotation.contentAnchor })}`];
    if (annotation.timeStart !== undefined || annotation.timeEnd !== undefined || annotation.snapshotAssetId) lines.push(`Media selection: ${encoded({ timeStart: annotation.timeStart, timeEnd: annotation.timeEnd, representativeFrameAssetId: annotation.snapshotAssetId })}`);
    if (capture) {
      lines.push(`Capture (reference_content): ${encoded({ captureId: capture.id, capturedAt: capture.capturedAt, version: capture.version, worldBounds: capture.worldBounds, viewport: capture.viewport, mapping: capture.mapping })}`);
      lines.push(`Scene evidence (reference_content): ${encoded({ objects: capture.scene.objects.map(value => ({ objectId: value.object.id, assetId: value.object.assetId, version: value.object.version, bounds: { x: value.object.x, y: value.object.y, width: value.object.width, height: value.object.height }, renderedBounds: value.renderedBounds, visibleBounds: value.visibleBounds, layer: value.layer, media: value.media, scroll: value.scroll, sourceTaskId: value.object.sourceTaskId, sourceRunId: value.object.sourceRunId })), assets: capture.scene.assets.map(asset => ({ assetId: asset.id, name: asset.name, mime: asset.mime, sourceTaskId: asset.sourceTaskId, sourceRunId: asset.sourceRunId })), omittedCount: capture.scene.omittedCount })}`);
      lines.push(`Screenshot (reference_content): ${encoded({ screenshotAssetId: capture.screenshotAssetId, mime: capture.image.mime, width: capture.image.width, height: capture.image.height })}`);
    }
    sections.push(lines.join('\n'));
  });
  return requestText + (sections.length ? `\n\n${sections.join('\n\n')}` : '');
}
