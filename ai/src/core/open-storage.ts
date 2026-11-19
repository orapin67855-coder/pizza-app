import { openIdbStorage } from './idb-storage';
import { createMemoryStorage } from './storage';
import type { Storage } from './types';

export type StorageMode = 'indexeddb' | 'memory';

export interface OpenStorageOptions {
  /** Defaults to the global `indexedDB`. Pass `null` to force the in-memory fallback. */
  indexedDB?: IDBFactory | null;
  name?: string;
}

/**
 * Opens persistent storage, falling back to memory if IndexedDB is missing or blocked
 * (e.g. private browsing). The caller can check `mode` and warn that data will not persist.
 */
export async function openStorage(
  options: OpenStorageOptions = {},
): Promise<{ storage: Storage; mode: StorageMode }> {
  const factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
  if (factory) {
    try {
      const storage = await openIdbStorage({
        indexedDB: factory,
        ...(options.name !== undefined ? { name: options.name } : {}),
      });
      return { storage, mode: 'indexeddb' };
    } catch {
      // fall through to memory
    }
  }
  return { storage: createMemoryStorage(), mode: 'memory' };
}
