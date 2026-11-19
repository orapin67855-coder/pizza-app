import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorage } from '../src/core/storage';
import { createPizzaCore } from '../src/core/pizza-core';
import type { SessionInput, StoredSession, SyncTransport } from '../src/core/types';

const input = (over: Partial<SessionInput> = {}): SessionInput => ({
  exerciseId: 'arm-raise',
  startedAt: '2026-11-18T09:00:00.000Z',
  durationS: 75,
  reps: 5,
  status: 'completed',
  ...over,
});

let counter = 0;
const make = async (transport?: SyncTransport) => {
  counter = 0;
  return createPizzaCore({
    storage: createMemoryStorage(),
    ...(transport ? { transport } : {}),
    uuid: () => `uuid-${++counter}`,
    now: () => new Date('2026-11-18T12:00:00.000Z'),
    consentTextVersion: 'v1',
  });
};

const okTransport = (): SyncTransport & { calls: StoredSession[][] } => {
  const calls: StoredSession[][] = [];
  return {
    calls,
    async sendSessions(sessions) {
      calls.push([...sessions]);
      return { acceptedIds: sessions.map((s) => s.clientId) };
    },
  };
};

describe('exercises', () => {
  it('lists the built-in exercises', async () => {
    const core = await make();
    const list = await core.exercises.list();
    expect(list.map((e) => e.id)).toContain('arm-raise');
  });
});

describe('sessions', () => {
  it('saves a session with a generated clientId and no sync time', async () => {
    const core = await make();
    const saved = await core.sessions.save(input());
    expect(saved).toEqual({ ...input(), clientId: 'uuid-1', syncedAt: null });
  });

  it('keeps a caller-supplied clientId', async () => {
    const core = await make();
    expect((await core.sessions.save(input({ clientId: 'mine' }))).clientId).toBe('mine');
  });

  it('is idempotent: saving the same clientId twice stores it once and returns the first', async () => {
    const core = await make();
    const first = await core.sessions.save(input({ clientId: 'dup', reps: 5 }));
    const second = await core.sessions.save(input({ clientId: 'dup', reps: 9 }));
    expect(second).toEqual(first);
    expect(await core.sessions.list()).toHaveLength(1);
  });

  it('normalises startedAt to a canonical ISO string', async () => {
    const core = await make();
    const saved = await core.sessions.save(input({ startedAt: '2026-11-18T09:00:00Z' }));
    expect(saved.startedAt).toBe('2026-11-18T09:00:00.000Z');
  });

  it.each([
    ['negative reps', { reps: -1 }],
    ['fractional reps', { reps: 2.5 }],
    ['absurd reps', { reps: 100000 }],
    ['negative duration', { durationS: -5 }],
    ['non-finite duration', { durationS: Infinity }],
    ['unknown status', { status: 'weird' as never }],
    ['empty exercise id', { exerciseId: '' }],
    ['malformed date', { startedAt: 'yesterday' }],
  ])('rejects %s', async (_label, over) => {
    const core = await make();
    await expect(core.sessions.save(input(over))).rejects.toThrow();
    expect(await core.sessions.list()).toEqual([]);
  });

  it('refuses extra fields so landmarks or video can never be stored by accident', async () => {
    const core = await make();
    const sneaky = { ...input(), landmarks: [[{ x: 0, y: 0 }]] } as unknown as SessionInput;
    await expect(core.sessions.save(sneaky)).rejects.toThrow();
    expect(await core.sessions.list()).toEqual([]);
  });

  it('lists sessions oldest first and supports a date range', async () => {
    const core = await make();
    await core.sessions.save(input({ startedAt: '2026-11-19T09:00:00.000Z' }));
    await core.sessions.save(input({ startedAt: '2026-11-17T09:00:00.000Z' }));
    const all = await core.sessions.list();
    expect(all.map((s) => s.startedAt)).toEqual([
      '2026-11-17T09:00:00.000Z',
      '2026-11-19T09:00:00.000Z',
    ]);
    expect(await core.sessions.list({ from: '2026-11-18T00:00:00.000Z' })).toHaveLength(1);
  });
});

describe('consent', () => {
  it('is not granted until the user says so', async () => {
    const core = await make();
    expect(await core.consent.get('sync_sessions')).toBeNull();
  });

  it('records a grant with the consent text version and time', async () => {
    const core = await make();
    const c = await core.consent.set('sync_sessions', true);
    expect(c).toEqual({
      purpose: 'sync_sessions',
      granted: true,
      textVersion: 'v1',
      grantedAt: '2026-11-18T12:00:00.000Z',
      revokedAt: null,
    });
    expect(await core.consent.get('sync_sessions')).toEqual(c);
  });

  it('records a revocation and keeps when it was originally granted', async () => {
    const core = await make();
    await core.consent.set('sync_sessions', true);
    const c = await core.consent.set('sync_sessions', false);
    expect(c).toMatchObject({
      granted: false,
      grantedAt: '2026-11-18T12:00:00.000Z',
      revokedAt: '2026-11-18T12:00:00.000Z',
    });
  });

  it('clears the revocation when consent is granted again', async () => {
    const core = await make();
    await core.consent.set('ai_summary', true);
    await core.consent.set('ai_summary', false);
    const c = await core.consent.set('ai_summary', true);
    expect(c).toMatchObject({ granted: true, revokedAt: null });
  });

  it('lists every recorded consent', async () => {
    const core = await make();
    await core.consent.set('sync_sessions', true);
    await core.consent.set('ai_summary', false);
    expect((await core.consent.list()).map((c) => c.purpose).sort()).toEqual([
      'ai_summary',
      'sync_sessions',
    ]);
  });
});

describe('sync.flush', () => {
  it('skips when no transport is configured (offline-only mode)', async () => {
    const core = await make();
    expect(await core.sync.flush()).toEqual({ status: 'skipped', reason: 'no-transport' });
  });

  it('never sends anything without the sync consent', async () => {
    const t = okTransport();
    const core = await make(t);
    await core.sessions.save(input());
    expect(await core.sync.flush()).toEqual({ status: 'skipped', reason: 'no-consent' });
    expect(t.calls).toHaveLength(0);
  });

  it('skips when everything is already synced', async () => {
    const core = await make(okTransport());
    await core.consent.set('sync_sessions', true);
    expect(await core.sync.flush()).toEqual({ status: 'skipped', reason: 'nothing-to-sync' });
  });

  it('sends unsynced sessions and marks them synced', async () => {
    const t = okTransport();
    const core = await make(t);
    await core.consent.set('sync_sessions', true);
    await core.sessions.save(input({ clientId: 'a' }));
    await core.sessions.save(input({ clientId: 'b', startedAt: '2026-11-18T10:00:00.000Z' }));
    expect(await core.sync.flush()).toEqual({ status: 'ok', sent: 2 });
    expect(t.calls[0]?.map((s) => s.clientId)).toEqual(['a', 'b']);
    expect((await core.sessions.list()).every((s) => s.syncedAt !== null)).toBe(true);
    expect(await core.sync.flush()).toEqual({ status: 'skipped', reason: 'nothing-to-sync' });
  });

  it('keeps sessions unsynced when the transport fails, and a retry succeeds', async () => {
    let fail = true;
    const sent: string[] = [];
    const core = await make({
      async sendSessions(sessions) {
        if (fail) throw new Error('network down');
        sent.push(...sessions.map((s) => s.clientId));
        return { acceptedIds: sessions.map((s) => s.clientId) };
      },
    });
    await core.consent.set('sync_sessions', true);
    await core.sessions.save(input({ clientId: 'a' }));

    expect(await core.sync.flush()).toEqual({ status: 'error', error: 'network down', sent: 0 });
    expect((await core.sessions.list())[0]?.syncedAt).toBeNull();

    fail = false;
    expect(await core.sync.flush()).toEqual({ status: 'ok', sent: 1 });
    expect(sent).toEqual(['a']);
  });

  it('only marks what the server accepted', async () => {
    const core = await make({
      async sendSessions() {
        return { acceptedIds: ['a'] };
      },
    });
    await core.consent.set('sync_sessions', true);
    await core.sessions.save(input({ clientId: 'a' }));
    await core.sessions.save(input({ clientId: 'b', startedAt: '2026-11-18T10:00:00.000Z' }));
    await core.sync.flush();
    const byId = Object.fromEntries((await core.sessions.list()).map((s) => [s.clientId, s]));
    expect(byId['a']?.syncedAt).not.toBeNull();
    expect(byId['b']?.syncedAt).toBeNull();
  });

  it('stops sending as soon as consent is revoked', async () => {
    const t = okTransport();
    const core = await make(t);
    await core.consent.set('sync_sessions', true);
    await core.consent.set('sync_sessions', false);
    await core.sessions.save(input());
    expect(await core.sync.flush()).toEqual({ status: 'skipped', reason: 'no-consent' });
    expect(t.calls).toHaveLength(0);
  });

  it('sends in batches of 50', async () => {
    const t = okTransport();
    const core = await make(t);
    await core.consent.set('sync_sessions', true);
    for (let i = 0; i < 120; i++) {
      await core.sessions.save(
        input({
          clientId: `s${i}`,
          startedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    expect(await core.sync.flush()).toEqual({ status: 'ok', sent: 120 });
    expect(t.calls.map((c) => c.length)).toEqual([50, 50, 20]);
  });

  it('reports partial progress if a later batch fails', async () => {
    let n = 0;
    const core = await make({
      async sendSessions(sessions) {
        if (++n === 2) throw new Error('boom');
        return { acceptedIds: sessions.map((s) => s.clientId) };
      },
    });
    await core.consent.set('sync_sessions', true);
    for (let i = 0; i < 60; i++) {
      await core.sessions.save(
        input({
          clientId: `s${i}`,
          startedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    expect(await core.sync.flush()).toEqual({ status: 'error', error: 'boom', sent: 50 });
    expect(await core.sync.flush()).toEqual({ status: 'ok', sent: 10 });
  });
});

describe('data', () => {
  it('exports sessions and consents for the user (PDPA data portability)', async () => {
    const core = await make();
    await core.sessions.save(input({ clientId: 'a' }));
    await core.consent.set('sync_sessions', true);
    const out = await core.data.exportAll();
    expect(out.exportedAt).toBe('2026-11-18T12:00:00.000Z');
    expect(out.sessions.map((s) => s.clientId)).toEqual(['a']);
    expect(out.consents.map((c) => c.purpose)).toEqual(['sync_sessions']);
  });

  it('deletes everything locally', async () => {
    const core = await make();
    await core.sessions.save(input());
    await core.consent.set('sync_sessions', true);
    expect(await core.data.deleteAll()).toEqual({ local: true, cloud: 'skipped' });
    expect(await core.sessions.list()).toEqual([]);
    expect(await core.consent.list()).toEqual([]);
  });

  it('also deletes cloud data when the transport supports it', async () => {
    const deleteMyData = vi.fn(async () => {});
    const core = await make({ ...okTransport(), deleteMyData });
    expect(await core.data.deleteAll()).toEqual({ local: true, cloud: 'deleted' });
    expect(deleteMyData).toHaveBeenCalledOnce();
  });

  it('still clears local data, and says so, when the cloud deletion fails', async () => {
    const core = await make({
      ...okTransport(),
      async deleteMyData() {
        throw new Error('offline');
      },
    });
    await core.sessions.save(input());
    expect(await core.data.deleteAll()).toEqual({ local: true, cloud: 'failed' });
    expect(await core.sessions.list()).toEqual([]);
  });
});
