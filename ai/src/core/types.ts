export type SessionStatus = 'completed' | 'stopped';

/** What the UI hands us when a session ends. Summary numbers only - never video or landmarks. */
export interface SessionInput {
  exerciseId: string;
  /** ISO-8601 timestamp. */
  startedAt: string;
  durationS: number;
  reps: number;
  status: SessionStatus;
  /** Optional caller-supplied id; reusing it makes saving idempotent. */
  clientId?: string;
}

export interface StoredSession {
  /** Unique, client-generated. The server upserts on it, so retries never duplicate. */
  clientId: string;
  exerciseId: string;
  startedAt: string;
  durationS: number;
  reps: number;
  status: SessionStatus;
  /** ISO timestamp of the successful sync, or null while it only exists on this device. */
  syncedAt: string | null;
}

export type ConsentPurpose =
  'sync_sessions' | 'share_with_physio' | 'community_clip' | 'ai_summary';

export const CONSENT_PURPOSES: readonly ConsentPurpose[] = [
  'sync_sessions',
  'share_with_physio',
  'community_clip',
  'ai_summary',
];

export interface ConsentRecord {
  purpose: ConsentPurpose;
  granted: boolean;
  /** Version of the consent text the user saw, so we can prove what they agreed to. */
  textVersion: string;
  grantedAt: string | null;
  revokedAt: string | null;
}

export interface DateRange {
  /** Inclusive ISO lower bound on `startedAt`. */
  from?: string;
  /** Inclusive ISO upper bound on `startedAt`. */
  to?: string;
}

export interface ExportedData {
  exportedAt: string;
  sessions: StoredSession[];
  consents: ConsentRecord[];
}

/** Local persistence. Implementations must be idempotent on `clientId`. */
export interface Storage {
  /** Returns true if inserted, false if a session with that clientId already existed. */
  putSession(session: StoredSession): Promise<boolean>;
  getSession(clientId: string): Promise<StoredSession | null>;
  /** Sorted by `startedAt`, oldest first. */
  listSessions(range?: DateRange): Promise<StoredSession[]>;
  listUnsynced(): Promise<StoredSession[]>;
  markSynced(clientIds: readonly string[], syncedAt: string): Promise<void>;
  getConsent(purpose: ConsentPurpose): Promise<ConsentRecord | null>;
  setConsent(record: ConsentRecord): Promise<void>;
  listConsents(): Promise<ConsentRecord[]>;
  clearAll(): Promise<void>;
}

/** Cloud side of sync; implemented against Supabase in Phase 3. */
export interface SyncTransport {
  /** Resolves with the clientIds the server accepted (or already had). */
  sendSessions(sessions: readonly StoredSession[]): Promise<{ acceptedIds: string[] }>;
  /**
   * Tells the server the user's current consent choices (server stamps the time). Best effort:
   * failures never block local use. Revocations must be delivered too.
   */
  sendConsents?(records: readonly ConsentRecord[]): Promise<void>;
  /** Deletes everything held for this user in the cloud. */
  deleteMyData?(): Promise<void>;
}
