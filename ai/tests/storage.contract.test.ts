import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { openIdbStorage } from '../src/core/idb-storage';
import { createMemoryStorage } from '../src/core/storage';
import type { ConsentRecord, Storage, StoredSession } from '../src/core/types';

const session = (n: number, over: Partial<StoredSession> = {}): StoredSession => ({
  clientId: `id-${n}`,
  exerciseId: 'arm-raise',
  startedAt: `2026-11-1${n}T09:00:00.000Z`,
  durationS: 60 + n,
  reps: 5,
  status: 'completed',
  syncedAt: null,
  ...over,
});

const consent = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
  purpose: 'sync_sessions',
  granted: true,
  textVersion: 'v1',
  grantedAt: '2026-11-18T10:00:00.000Z',
  revokedAt: null,
  ...over,
});

const factories: Array<[string, () => Promise<Storage>]> = [
  ['memory', async () => createMemoryStorage()],
  // a fresh IDBFactory per test = a fresh empty database
  ['indexeddb', async () => openIdbStorage({ indexedDB: new IDBFactory() })],
];

describe.each(factories)('Storage contract: %s', (_name, make) => {
  let s: Storage;
  beforeEach(async () => {
    s = await make();
  });

  it('starts empty', async () => {
    expect(await s.listSessions()).toEqual([]);
    expect(await s.listUnsynced()).toEqual([]);
    expect(await s.listConsents()).toEqual([]);
  });

  it('stores a session and reports it as inserted', async () => {
    expect(await s.putSession(session(1))).toBe(true);
    expect(await s.listSessions()).toEqual([session(1)]);
  });

  it('is idempotent on clientId: a second put is ignored and keeps the original', async () => {
    await s.putSession(session(1));
    expect(await s.putSession(session(1, { reps: 99 }))).toBe(false);
    expect((await s.listSessions())[0]?.reps).toBe(5);
  });

  it('gets a single session by clientId, or null', async () => {
    await s.putSession(session(1));
    expect(await s.getSession('id-1')).toEqual(session(1));
    expect(await s.getSession('missing')).toBeNull();
  });

  it('lists sessions oldest first', async () => {
    await s.putSession(session(3));
    await s.putSession(session(1));
    await s.putSession(session(2));
    expect((await s.listSessions()).map((x) => x.clientId)).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('filters by an inclusive date range', async () => {
    for (const n of [1, 2, 3]) await s.putSession(session(n));
    const got = await s.listSessions({
      from: '2026-11-12T00:00:00.000Z',
      to: '2026-11-12T23:59:59.999Z',
    });
    expect(got.map((x) => x.clientId)).toEqual(['id-2']);
  });

  it('supports an open-ended range', async () => {
    for (const n of [1, 2, 3]) await s.putSession(session(n));
    expect((await s.listSessions({ from: '2026-11-12T00:00:00.000Z' })).length).toBe(2);
    expect((await s.listSessions({ to: '2026-11-11T23:59:59.999Z' })).length).toBe(1);
  });

  it('tracks which sessions still need syncing', async () => {
    await s.putSession(session(1));
    await s.putSession(session(2, { syncedAt: '2026-11-18T00:00:00.000Z' }));
    expect((await s.listUnsynced()).map((x) => x.clientId)).toEqual(['id-1']);
  });

  it('marks sessions as synced, ignoring unknown ids', async () => {
    await s.putSession(session(1));
    await s.putSession(session(2));
    await s.markSynced(['id-1', 'nope'], '2026-11-18T12:00:00.000Z');
    expect((await s.listUnsynced()).map((x) => x.clientId)).toEqual(['id-2']);
    expect((await s.listSessions())[0]?.syncedAt).toBe('2026-11-18T12:00:00.000Z');
  });

  it('returns null for a consent that was never recorded', async () => {
    expect(await s.getConsent('ai_summary')).toBeNull();
  });

  it('stores and replaces a consent record per purpose', async () => {
    await s.setConsent(consent());
    await s.setConsent(
      consent({ granted: false, revokedAt: '2026-11-19T00:00:00.000Z', textVersion: 'v2' }),
    );
    const got = await s.getConsent('sync_sessions');
    expect(got).toMatchObject({ granted: false, textVersion: 'v2' });
    expect(await s.listConsents()).toHaveLength(1);
  });

  it('keeps consents for different purposes separate', async () => {
    await s.setConsent(consent({ purpose: 'sync_sessions' }));
    await s.setConsent(consent({ purpose: 'ai_summary', granted: false }));
    expect((await s.getConsent('sync_sessions'))?.granted).toBe(true);
    expect((await s.getConsent('ai_summary'))?.granted).toBe(false);
  });

  it('clearAll removes sessions and consents', async () => {
    await s.putSession(session(1));
    await s.setConsent(consent());
    await s.clearAll();
    expect(await s.listSessions()).toEqual([]);
    expect(await s.listConsents()).toEqual([]);
  });

  it('does not let callers mutate stored data by holding a reference', async () => {
    const original = session(1);
    await s.putSession(original);
    original.reps = 123;
    const [got] = await s.listSessions();
    expect(got?.reps).toBe(5);
    if (got) got.reps = 456;
    expect((await s.listSessions())[0]?.reps).toBe(5);
  });
});

describe('openIdbStorage persistence', () => {
  it('keeps data across re-opening the same database', async () => {
    const factory = new IDBFactory();
    const first = await openIdbStorage({ indexedDB: factory });
    await first.putSession(session(1));
    const second = await openIdbStorage({ indexedDB: factory });
    expect((await second.listSessions()).map((x) => x.clientId)).toEqual(['id-1']);
  });
});
