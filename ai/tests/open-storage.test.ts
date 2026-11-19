import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openStorage } from '../src/core/open-storage';

describe('openStorage', () => {
  it('uses IndexedDB when it is available', async () => {
    const r = await openStorage({ indexedDB: new IDBFactory() });
    expect(r.mode).toBe('indexeddb');
    await r.storage.setConsent({
      purpose: 'sync_sessions',
      granted: true,
      textVersion: 'v1',
      grantedAt: null,
      revokedAt: null,
    });
    expect(await r.storage.listConsents()).toHaveLength(1);
  });

  it('falls back to memory when IndexedDB does not exist, instead of crashing', async () => {
    const r = await openStorage({ indexedDB: null });
    expect(r.mode).toBe('memory');
  });

  it('falls back to memory when opening IndexedDB fails (e.g. storage blocked)', async () => {
    const blocked = {
      open() {
        throw new Error('SecurityError');
      },
    } as unknown as IDBFactory;
    const r = await openStorage({ indexedDB: blocked });
    expect(r.mode).toBe('memory');
    await r.storage.putSession({
      clientId: 'a',
      exerciseId: 'arm-raise',
      startedAt: '2026-11-18T09:00:00.000Z',
      durationS: 1,
      reps: 1,
      status: 'completed',
      syncedAt: null,
    });
    expect(await r.storage.listSessions()).toHaveLength(1);
  });
});
