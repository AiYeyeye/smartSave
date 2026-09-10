export const OPERATIONS_DATABASE_VERSION = 3;

/** One additive migration owner for mutation evidence and import progress and file output. Never delete stores. */
export function openOperationsDatabase(factory: IDBFactory, name = 'zhilan-operations'): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (reason: string) => { settled = true; reject(Error(reason)); };
    const request = factory.open(name, OPERATIONS_DATABASE_VERSION);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (event.oldVersion < 1 && !db.objectStoreNames.contains('operations')) db.createObjectStore('operations', { keyPath: 'requestId' });
      if (event.oldVersion < 2 && !db.objectStoreNames.contains('importCheckpoints')) db.createObjectStore('importCheckpoints', { keyPath: 'id' });
      if (event.oldVersion < 3 && !db.objectStoreNames.contains('fileOutput')) db.createObjectStore('fileOutput');
    };
    request.onerror = () => fail(request.error?.name === 'VersionError' ? 'unsupported-journal' : 'journal-unavailable');
    request.onblocked = () => fail('journal-blocked');
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      if (!db.objectStoreNames.contains('operations') || !db.objectStoreNames.contains('importCheckpoints') || !db.objectStoreNames.contains('fileOutput')) { db.close(); fail('unsupported-journal'); return; }
      db.onversionchange = () => db.close();
      settled = true;
      resolve(db);
    };
  });
}
