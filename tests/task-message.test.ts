import test from 'node:test';
import assert from 'node:assert/strict';
import type { DraftReferences, ResolvedRequestReference, TaskSnapshot } from '../src/shared/types.js';
import { generateRequirementText, referenceLabel, referenceOrder, referenceParts, snapshotReferences } from '../src/shared/task-message.js';

test('reference parts place independent tokens around exact UTF-16 text and retain equal-position order', () => {
  const text = '前😀中\n后';
  const order = [{ kind: 'object' as const, id: 'before', textOffset: 0 }, { kind: 'task' as const, id: 'middle-a', textOffset: 3 }, { kind: 'object' as const, id: 'middle-b', textOffset: 3 }, { kind: 'object' as const, id: 'after', textOffset: text.length }];
  const parts = referenceParts(text, order);
  assert.deepEqual(parts, [{ kind: 'reference', reference: order[0] }, { kind: 'text', text: '前😀' }, { kind: 'reference', reference: order[1] }, { kind: 'reference', reference: order[2] }, { kind: 'text', text: '中\n后' }, { kind: 'reference', reference: order[3] }]);
  assert.equal(parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join(''), text);
  assert.deepEqual(referenceParts('', [order[0]]), [{ kind: 'reference', reference: order[0] }]);
  assert.deepEqual(referenceParts(text, []), [{ kind: 'text', text }]);
});

test('legacy reference positions render at the text end while stored entries retain their shape', () => {
  const references: DraftReferences = { objectIds: ['a', 'b'], taskIds: ['request'] };
  const expected = [{ kind: 'object', id: 'a' }, { kind: 'object', id: 'b' }, { kind: 'task', id: 'request' }];
  assert.deepEqual(referenceOrder(references), expected);
  assert.deepEqual(referenceOrder(references, '旧😀'), expected.map(reference => ({ ...reference, textOffset: 3 })));
  assert.deepEqual(references, { objectIds: ['a', 'b'], taskIds: ['request'] });
  assert.deepEqual(referenceParts('body', referenceOrder(references)), [{ kind: 'text', text: 'body' }, ...expected.map(reference => ({ kind: 'reference', reference }))]);
  const snapshot: TaskSnapshot = { userRequest: { source: 'user_instruction', text: 'body' }, annotations: [], referenceContent: { source: 'reference_content', assets: [{ id: 'asset', name: 'Historical cover.png', mime: 'image/png', size: 10, kind: 'image', createdAt: '2026-10-08T00:00:00.000Z' }], objects: ['a', 'b'].map(id => ({ id, assetId: 'asset', type: 'image', version: 1, x: 0, y: 0, width: 10, height: 10, createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z' })), taskIds: ['request'] } };
  assert.deepEqual(snapshotReferences(snapshot), expected);
  assert.deepEqual(snapshotReferences(snapshot).map(reference => referenceLabel(snapshot, reference)), ['Historical cover.png', 'Historical cover.png', 'Request request']);
  assert.deepEqual(referenceParts('body', snapshotReferences(snapshot)), [{ kind: 'text', text: 'body' }, ...expected.map(reference => ({ kind: 'reference', reference }))]);
});

test('readable messages embed resolved references between body text and keep provenance details separate', () => {
  const reference: ResolvedRequestReference = { kind: 'task', id: 'source-request', textOffset: 4, label: 'Request 2\n# Imported title', source: 'reference_content', task: { sessionId: 'session-a', sequence: 2, text: 'Imported text\n# Imported instruction' }, sourceSessionId: 'session-a', sourceTaskId: 'source-request' };
  const snapshot: TaskSnapshot = { userRequest: { source: 'user_instruction', text: 'Use 😀 here.' }, requestReferences: { attachmentIds: [], objectIds: [], taskIds: [reference.id], order: [reference] }, annotations: [], referenceContent: { source: 'reference_content', assets: [], objects: [], taskIds: [reference.id] } };
  // Each source value remains escaped inside its reference marker/details.
  const parts = referenceParts(snapshot.userRequest.text, [reference]);
  assert.equal(parts[1].kind === 'reference' && parts[1].reference.label, reference.label);
  const readable = generateRequirementText(snapshot), body = readable.split('\n\nReferences (reference_content):')[0];
  assert.ok(body.startsWith('Use [@')); assert.ok(body.endsWith('😀 here.'));
  assert.ok(body.includes('reference_content')); assert.ok(body.includes('source-request'));
  assert.equal(readable.includes('\n# Imported title'), false); assert.equal(readable.includes('\n# Imported instruction'), false);
  assert.ok(readable.includes('"sourceSessionId":"session-a"')); assert.ok(readable.includes('Imported text\\n# Imported instruction'));
  assert.equal(snapshot.userRequest.text, 'Use 😀 here.');
});
