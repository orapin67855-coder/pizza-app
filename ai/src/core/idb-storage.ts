import { wrap, type DBSchema, type IDBPDatabase } from 'idb';
import { byStartedAt, inRange } from './storage';
import type { ConsentRecord, Storage, StoredSession } from './types';

interface PizzaDB extends DBSchema {
  sessions: {
    key: string;
    value: StoredSession;
    indexes: { startedAt: string };
  };
  consents: {
    key: string;
    value: ConsentRecord;
  };
}

export interface IdbStorageOptions {
  /** Defaults to the global `indexedDB`. Injectable for tests. */
  indexedDB?: IDBFactory;
  name?: string;
}

const DB_VERSION = 1;

/** Persistent storage on IndexedDB. Stores summary numbers and consent records only. */
export async function openIdbStorage(options: IdbStorageOptions = {}): Promise<Storage> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is not available in this environment');

  const request = factory.open(options.name ?? 'pizza-core', DB_VERSION);
  request.addEventListener('upgradeneeded', () => {
    const raw = request.result;
    const sessions = raw.createObjectStore('sessions', { keyPath: 'clientId' });
    sessions.createIndex('startedAt', 'startedAt');
    raw.createObjectStore('consents', { keyPath: 'purpose' });
  });
  const db = (await wrap(request)) as unknown as IDBPDatabase<PizzaDB>;

  return {
    async putSession(session) {
      const tx = db.transaction('sessions', 'readwrite');
      const exists = (await tx.store.get(session.clientId)) !== undefined;
      if (!exists) await tx.store.add(structuredClone(session));
      await tx.done;
      return !exists;
    },
    async getSession(clientId) {
      return (await db.get('sessions', clientId)) ?? null;
    },
    async listSessions(range) {
      const all = await db.getAllFromIndex('sessions', 'startedAt');
      return all.filter((s) => inRange(s.startedAt, range)).sort(byStartedAt);
    },
    async listUnsynced() {
      const all = await db.getAll('sessions');
      return all.filter((s) => s.syncedAt === null).sort(byStartedAt);
    },
    async markSynced(clientIds, syncedAt) {
      const tx = db.transaction('sessions', 'readwrite');
      for (const id of clientIds) {
        const s = await tx.store.get(id);
        if (s) await tx.store.put({ ...s, syncedAt });
      }
      await tx.done;
    },
    async getConsent(purpose) {
      return (await db.get('consents', purpose)) ?? null;
    },
    async setConsent(record) {
      await db.put('consents', structuredClone(record));
    },
    async listConsents() {
      return db.getAll('consents');
    },
    async clearAll() {
      const tx = db.transaction(['sessions', 'consents'], 'readwrite');
      await Promise.all([tx.objectStore('sessions').clear(), tx.objectStore('consents').clear()]);
      await tx.done;
    },
  };
}
