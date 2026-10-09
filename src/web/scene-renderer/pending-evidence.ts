import type { SceneEvidenceFrame } from '../../shared/browser-capture.js';

const databaseName = 'acanvas-scene-evidence';
const storeName = 'pending';
const key = (frame: SceneEvidenceFrame) => [frame.identity.sessionId, frame.identity.draftId, frame.identity.annotationId, frame.identity.version].join(':');
interface PendingRecord { id: string; sessionId: string; savedAt: number; frame: SceneEvidenceFrame }
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => { const store = request.result.createObjectStore(storeName, { keyPath: 'id' }); store.createIndex('session', 'sessionId'); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
}

/** Persist the already copied PNG; recovery uses this Blob across documents and service restarts. */
export async function savePendingEvidence(frame: SceneEvidenceFrame): Promise<void> {
  if (frame.png.type !== 'image/png' || frame.png.size < 1 || frame.png.size > 20 * 1024 * 1024) throw new Error('Pending evidence uses PNG within its image limit.');
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, 'readwrite'), done = completed(transaction), store = transaction.objectStore(storeName), request = store.index('session').getAll(frame.identity.sessionId);
    request.onsuccess = () => {
      const records = request.result as PendingRecord[], existing = records.find(record => record.id === key(frame));
      if (!existing && records.length >= 8) { transaction.abort(); return; }
      store.put({ id: key(frame), sessionId: frame.identity.sessionId, savedAt: Date.now(), frame } satisfies PendingRecord);
    };
    await done;
  } finally { database.close(); }
}

export async function pendingEvidence(sessionId: string, draftId: string): Promise<SceneEvidenceFrame[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, 'readonly'), done = completed(transaction);
    const result = await new Promise<PendingRecord[]>((resolve, reject) => { const request = transaction.objectStore(storeName).index('session').getAll(sessionId); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await done; return result.filter(record => record.frame.identity.draftId === draftId).map(record => record.frame);
  } finally { database.close(); }
}

export async function removePendingEvidence(frame: SceneEvidenceFrame): Promise<void> {
  const database = await openDatabase();
  try { const transaction = database.transaction(storeName, 'readwrite'), done = completed(transaction); transaction.objectStore(storeName).delete(key(frame)); await done; }
  finally { database.close(); }
}
