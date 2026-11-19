import type { ConsentRecord, StoredSession, SyncTransport } from './types';

export interface SupabaseTransportOptions {
  /** e.g. https://<project>.supabase.co/functions/v1 */
  functionsUrl: string;
  /** The public anon key (safe to ship; row level security protects the data). */
  anonKey: string;
  /** Current user's access token, or null when nobody is signed in. */
  getAccessToken: () => Promise<string | null>;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Talks to the PIZZA Edge Functions. Errors are short codes the UI can act on:
 * `not-signed-in`, `consent-required`, `bad-response`, `sync-failed-<status>`.
 * Network errors are not caught here, so the caller keeps its data and retries later.
 */
export function createSupabaseTransport(
  options: SupabaseTransportOptions,
): Required<SyncTransport> {
  const base = options.functionsUrl.replace(/\/+$/, '');
  const fetchFn =
    options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  async function post(path: string, body: unknown): Promise<Response> {
    const token = await options.getAccessToken();
    if (!token) throw new Error('not-signed-in');

    const res = await fetchFn(`${base}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: options.anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    if (res.status === 401) throw new Error('not-signed-in');
    if (res.status === 403) {
      const detail = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (detail?.error === 'consent_required') throw new Error('consent-required');
    }
    throw new Error(`sync-failed-${res.status}`);
  }

  return {
    async sendSessions(sessions: readonly StoredSession[]) {
      const res = await post('sessions-batch', {
        sessions: sessions.map((s) => ({
          clientId: s.clientId,
          exerciseId: s.exerciseId,
          startedAt: s.startedAt,
          durationS: s.durationS,
          reps: s.reps,
          status: s.status,
        })),
      });
      const data = (await res.json().catch(() => null)) as { acceptedIds?: unknown } | null;
      const ids = data?.acceptedIds;
      if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) {
        throw new Error('bad-response');
      }
      return { acceptedIds: ids };
    },

    async sendConsents(records: readonly ConsentRecord[]) {
      if (records.length === 0) return;
      await post('consents', {
        consents: records.map((r) => ({
          purpose: r.purpose,
          granted: r.granted,
          textVersion: r.textVersion,
        })),
      });
    },

    async deleteMyData() {
      await post('delete-me', {});
    },
  };
}
