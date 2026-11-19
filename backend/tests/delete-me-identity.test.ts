import { describe, expect, it } from 'vitest';
import { handleDeleteMe } from '../supabase/functions/delete-me/handler.ts';
import { empty, ENV, fakeFetch, json } from './fake-fetch.ts';

const USER_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '99999999-8888-4777-8666-555555555555';

const responder = (call: { url: string }) =>
  call.url.endsWith('/auth/v1/user') ? json(200, { id: USER_ID }) : empty(200);

const request = (url: string, init: RequestInit = {}) =>
  new Request(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json' },
    ...init,
  });

describe('delete-me identity comes only from the token', () => {
  it.each([
    ['id query parameter', `https://fn.test/delete-me?id=${OTHER_ID}`, undefined],
    ['userId query parameter', `https://fn.test/delete-me?userId=${OTHER_ID}`, undefined],
    ['user_id in the body', 'https://fn.test/delete-me', JSON.stringify({ user_id: OTHER_ID })],
    ['id in the body', 'https://fn.test/delete-me', JSON.stringify({ id: OTHER_ID })],
  ])('ignores an id supplied via %s', async (_label, url, body) => {
    const f = fakeFetch(responder);
    await handleDeleteMe(request(url, body ? { body } : {}), ENV, f.fetch);
    const deleteCall = f.calls.find((c) => c.method === 'DELETE');
    expect(deleteCall?.url).toBe(`https://proj.supabase.test/auth/v1/admin/users/${USER_ID}`);
    expect(f.calls.map((c) => c.url).join('\n')).not.toContain(OTHER_ID);
  });
});
