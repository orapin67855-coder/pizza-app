import type { ConsentPurpose, ConsentRecord, DateRange, Storage, StoredSession } from './types';

/** ISO-8601 strings in the same format compare correctly as plain strings. */
export const inRange = (iso: string, range?: DateRange): boolean =>
  (range?.from === undefined || iso >= range.from) && (range?.to === undefined || iso <= range.to);

export const byStartedAt = (a: StoredSession, b: StoredSession): number =>
  a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.clientId < b.clientId ? -1 : 1;

/**
 * In-memory storage. Used in tests and as a fail-safe fallback when IndexedDB is unavailable
 * (private browsing, blocked storage): the app keeps working, it just will not persist.
 */
export function createMemoryStorage(): Storage {
  const sessions = new Map<string, StoredSession>();
  const consents = new Map<ConsentPurpose, ConsentRecord>();

  return {
    async putSession(session) {
      if (sessions.has(session.clientId)) return false;
      sessions.set(session.clientId, structuredClone(session));
      return true;
    },
    async getSession(clientId) {
      const s = sessions.get(clientId);
      return s ? structuredClone(s) : null;
    },
    async listSessions(range) {
      return [...sessions.values()]
        .filter((s) => inRange(s.startedAt, range))
        .sort(byStartedAt)
        .map((s) => structuredClone(s));
    },
    async listUnsynced() {
      return [...sessions.values()]
        .filter((s) => s.syncedAt === null)
        .sort(byStartedAt)
        .map((s) => structuredClone(s));
    },
    async markSynced(clientIds, syncedAt) {
      for (const id of clientIds) {
        const s = sessions.get(id);
        if (s) sessions.set(id, { ...s, syncedAt });
      }
    },
    async getConsent(purpose) {
      const c = consents.get(purpose);
      return c ? structuredClone(c) : null;
    },
    async setConsent(record) {
      consents.set(record.purpose, structuredClone(record));
    },
    async listConsents() {
      return [...consents.values()].map((c) => structuredClone(c));
    },
    async clearAll() {
      sessions.clear();
      consents.clear();
    },
  };
}
