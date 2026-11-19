import { describe, expect, it } from 'vitest';
import { assertLocalApi, parseArgs, setRole } from '../scripts/set-role-core.mjs';
import { fakeFetch, json } from './fake-fetch.ts';

const API = 'http://127.0.0.1:54321';
const UID = '11111111-2222-4333-8444-555555555555';

describe('parseArgs', () => {
  it('reads an email and a role', () => {
    expect(parseArgs(['Dr.Physio@Example.test', 'physio'])).toEqual({
      email: 'dr.physio@example.test',
      role: 'physio',
    });
  });

  it.each([
    ['nothing', []],
    ['only an email', ['a@example.test']],
    ['an extra argument', ['a@example.test', 'physio', 'now']],
    ['a malformed email', ['not-an-email', 'physio']],
    ['an unknown role', ['a@example.test', 'superuser']],
  ])('rejects %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(/usage|email|role/i);
  });
});

describe('assertLocalApi', () => {
  it.each(['http://127.0.0.1:54321', 'http://localhost:54321', 'http://[::1]:54321'])(
    'accepts %s',
    (url) => {
      expect(() => assertLocalApi(url)).not.toThrow();
    },
  );

  it.each([
    'https://abcdefgh.supabase.co',
    'http://127.0.0.1.evil.example',
    'http://localhost@evil.example',
    'http://evil.example/localhost',
    'not a url',
    '',
  ])('refuses %s (the service key must never go to a hosted project)', (url) => {
    expect(() => assertLocalApi(url)).toThrow(/local/i);
  });
});

describe('setRole', () => {
  const users = (list: { id: string; email: string }[]) => json(200, { users: list });
  const responder =
    (found = true, patched: unknown[] = [{ id: UID, role: 'physio' }]) =>
    (call: { url: string; method: string }) =>
      call.url.includes('/auth/v1/admin/users')
        ? users(found ? [{ id: UID, email: 'Dr.Physio@Example.test' }] : [])
        : json(200, patched);

  it('looks the account up by email (case-insensitive) and updates only that profile', async () => {
    const f = fakeFetch(responder());
    const result = await setRole(
      { api: API, serviceKey: 'service-key', fetchFn: f.fetch },
      'dr.physio@example.test',
      'physio',
    );
    expect(result).toEqual({ id: UID, role: 'physio' });

    const patch = f.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(`${API}/rest/v1/profiles?id=eq.${UID}`);
    expect(JSON.parse(patch.body ?? '{}')).toEqual({ role: 'physio' });
    expect(patch.headers['authorization']).toBe('Bearer service-key');
  });

  it('fails clearly when no account has that email, and changes nothing', async () => {
    const f = fakeFetch(responder(false));
    await expect(
      setRole({ api: API, serviceKey: 'k', fetchFn: f.fetch }, 'nobody@example.test', 'physio'),
    ).rejects.toThrow(/no account/i);
    expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('fails when the profile was not updated', async () => {
    const f = fakeFetch(responder(true, []));
    await expect(
      setRole({ api: API, serviceKey: 'k', fetchFn: f.fetch }, 'dr.physio@example.test', 'physio'),
    ).rejects.toThrow(/not updated/i);
  });

  it('pages through the account list', async () => {
    const f = fakeFetch((call) => {
      if (!call.url.includes('/auth/v1/admin/users'))
        return json(200, [{ id: UID, role: 'physio' }]);
      return call.url.includes('?page=1&')
        ? users(Array.from({ length: 1000 }, (_, i) => ({ id: `x${i}`, email: `u${i}@e.test` })))
        : users([{ id: UID, email: 'late@example.test' }]);
    });
    const r = await setRole(
      { api: API, serviceKey: 'k', fetchFn: f.fetch },
      'late@example.test',
      'physio',
    );
    expect(r.id).toBe(UID);
  });

  it('refuses a non-local API before making any request', async () => {
    const f = fakeFetch(responder());
    await expect(
      setRole(
        { api: 'https://abcdefgh.supabase.co', serviceKey: 'k', fetchFn: f.fetch },
        'dr.physio@example.test',
        'physio',
      ),
    ).rejects.toThrow(/local/i);
    expect(f.calls).toHaveLength(0);
  });
});
