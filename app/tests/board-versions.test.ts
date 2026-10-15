import test from 'node:test';
import assert from 'node:assert/strict';
import { ownExpectedVersion, rememberVersionChanges, type OwnVersions } from '../src/web/board-versions.js';

test('queued neighbor and history writes follow only consecutive own version transitions', () => {
  const objects: OwnVersions = new Map(), groups: OwnVersions = new Map();
  // A folder mode change compacts its neighbor; a subsequent undo advances it again.
  rememberVersionChanges(objects, [{ id: 'neighbor', beforeVersion: 4, version: 5 }]);
  rememberVersionChanges(groups, [{ id: 'neighbor-group', beforeVersion: 2, version: 3 }]);
  assert.equal(ownExpectedVersion(objects, 'neighbor', 4), 5);
  assert.equal(ownExpectedVersion(groups, 'neighbor-group', 2), 3);
  rememberVersionChanges(objects, [{ id: 'neighbor', beforeVersion: 5, version: 6 }]);
  assert.equal(ownExpectedVersion(objects, 'neighbor', 4), 6);
  assert.equal(ownExpectedVersion(objects, 'neighbor', 5), 6);
  assert.equal(ownExpectedVersion(objects, 'neighbor', 3), 3);
  // An external write breaks the chain before the next successful local mutation.
  rememberVersionChanges(objects, [{ id: 'neighbor', beforeVersion: 7, version: 8 }]);
  assert.equal(ownExpectedVersion(objects, 'neighbor', 4), 4);
  assert.equal(ownExpectedVersion(objects, 'neighbor', 6), 6);
  assert.equal(ownExpectedVersion(objects, 'neighbor', 7), 8);
});

test('creation and deletion track current identity without accepting earlier stale versions', () => {
  const versions: OwnVersions = new Map();
  rememberVersionChanges(versions, [{ id: 'note', version: 1 }]);
  assert.equal(ownExpectedVersion(versions, 'note', 0), 0);
  rememberVersionChanges(versions, [{ id: 'note', beforeVersion: 1, version: 2 }]);
  assert.equal(ownExpectedVersion(versions, 'note', 1), 2);
  rememberVersionChanges(versions, [{ id: 'note', beforeVersion: 2 }]);
  assert.equal(ownExpectedVersion(versions, 'note', 1), 1);
  rememberVersionChanges(versions, [{ id: 'note', version: 3 }]);
  assert.equal(ownExpectedVersion(versions, 'note', 1), 1);
});
