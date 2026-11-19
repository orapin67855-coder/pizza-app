import { describe, expect, it, vi } from 'vitest';
import { createPizzaCore } from '../src/core/pizza-core';
import { createMemoryStorage } from '../src/core/storage';
import type { ConsentRecord, SessionInput, SyncTransport } from '../src/core/types';

const input = (id: string): SessionInput => ({
  exerciseId: 'arm-raise',
  startedAt: '2026-11-18T09:00:00.000Z',
  durationS: 60,
  reps: 5,
  status: 'completed',
  clientId: id,
});

const make = (transport: SyncTransport) =>
  createPizzaCore({
    storage: createMemoryStorage(),
    transport,
    now: () => new Date('2026-11-18T12:00:00.000Z'),
  });

function recorder(over: Partial<SyncTransport> = {}) {
  const log: string[] = [];
  const consents: ConsentRecord[][] = [];
  const transport: SyncTransport = {
    async sendSessions(s) {
      log.push('sessions');
      return { acceptedIds: s.map((x) => x.clientId) };
    },
    async sendConsents(records) {
      log.push('consents');
      consents.push([...records]);
    },
    ...over,
  };
  return { transport, log, consents };
}

describe('consent changes reach the server', () => {
  it('pushes a new consent record as soon as it is set', async () => {
    const r = recorder();
    const core = await make(r.transport);
    await core.consent.set('sync_sessions', true);
    expect(r.consents).toHaveLength(1);
    expect(r.consents[0]?.[0]).toMatchObject({ purpose: 'sync_sessions', granted: true });
  });

  it('pushes a revocation too', async () => {
    const r = recorder();
    const core = await make(r.transport);
    await core.consent.set('sync_sessions', true);
    await core.consent.set('sync_sessions', false);
    expect(r.consents.at(-1)?.[0]).toMatchObject({ granted: false });
  });

  it('still records the consent locally when the server cannot be reached', async () => {
    const r = recorder({
      async sendConsents() {
        throw new Error('offline');
      },
    });
    const core = await make(r.transport);
    const c = await core.consent.set('sync_sessions', true);
    expect(c.granted).toBe(true);
    expect((await core.consent.get('sync_sessions'))?.granted).toBe(true);
  });

  it('works with a transport that has no consent endpoint', async () => {
    const core = await make({
      async sendSessions(s) {
        return { acceptedIds: s.map((x) => x.clientId) };
      },
    });
    await expect(core.consent.set('sync_sessions', true)).resolves.toMatchObject({ granted: true });
  });
});

describe('sync.flush keeps the server in step with local consent', () => {
  it('re-sends consents before sessions, healing an earlier failed push', async () => {
    let fail = true;
    const r = recorder({
      async sendConsents(records) {
        if (fail) throw new Error('offline');
        r.log.push('consents');
        r.consents.push([...records]);
      },
    });
    const core = await make(r.transport);
    await core.consent.set('sync_sessions', true); // push fails
    await core.sessions.save(input('a'));
    fail = false;
    expect(await core.sync.flush()).toEqual({ status: 'ok', sent: 1 });
    expect(r.log).toEqual(['consents', 'sessions']);
  });

  it('still delivers a revocation when sync consent is off, and sends no sessions', async () => {
    let fail = false;
    const r = recorder({
      async sendConsents(records) {
        if (fail) throw new Error('offline');
        r.log.push('consents');
        r.consents.push([...records]);
      },
    });
    const core = await make(r.transport);
    await core.consent.set('sync_sessions', true);
    await core.sessions.save(input('a'));
    fail = true;
    await core.consent.set('sync_sessions', false); // revocation could not reach the server
    r.log.length = 0;
    r.consents.length = 0;
    fail = false;

    expect(await core.sync.flush()).toEqual({ status: 'skipped', reason: 'no-consent' });
    expect(r.consents[0]?.[0]).toMatchObject({ purpose: 'sync_sessions', granted: false });
    expect(r.log).toEqual(['consents']);
  });

  it('does not let a failing consent push block or crash the flush', async () => {
    const r = recorder({
      async sendConsents() {
        throw new Error('offline');
      },
    });
    const core = await make(r.transport);
    await core.consent.set('sync_sessions', true);
    await core.sessions.save(input('a'));
    expect(await core.sync.flush()).toEqual({ status: 'ok', sent: 1 });
  });

  it('skips the consent push when there are no consents at all', async () => {
    const sendConsents = vi.fn(async () => {});
    const r = recorder({ sendConsents });
    const core = await make(r.transport);
    await core.sync.flush();
    expect(sendConsents).not.toHaveBeenCalled();
  });
});
