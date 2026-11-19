import { EN_MESSAGES } from '../coach/messages/en';
import type { CueKey } from '../coach/cues';
import { DEFAULT_EXERCISES } from '../exercises/defaults';
import type { Exercise } from '../types/exercise';
import { openStorage, type StorageMode } from './open-storage';
import { createMediaPipeBackend, type PoseBackend, type VisionModule } from './pose-backend';
import {
  defaultScheduler,
  startPoseController,
  type PoseController,
  type PoseHandlers,
  type PoseStartOptions,
  type Scheduler,
} from './pose-controller';
import { parseSessionInput } from './session-schema';
import type {
  ConsentPurpose,
  ConsentRecord,
  DateRange,
  ExportedData,
  SessionInput,
  Storage,
  StoredSession,
  SyncTransport,
} from './types';

export interface PizzaCoreOptions {
  /** Defaults to IndexedDB with an in-memory fallback. */
  storage?: Storage;
  /** Cloud sync. Without it the app is purely local. */
  transport?: SyncTransport;
  uuid?: () => string;
  now?: () => Date;
  /** Version label of the consent text shown to the user; stored with every consent. */
  consentTextVersion?: string;
  exercises?: readonly Exercise[];
  /** Factory for the camera + pose backend. Takes precedence over `vision` + `assets`. */
  createPoseBackend?: () => PoseBackend;
  /** The `@mediapipe/tasks-vision` module (pin 0.10.14), injected so it is not bundled here. */
  vision?: VisionModule;
  /** Self-hosted MediaPipe assets used with `vision`. */
  assets?: { wasmPath: string; modelPath: string };
  /** Cue text by key; defaults to English. */
  messages?: Record<CueKey, string>;
  scheduler?: Scheduler;
  /** Monotonic millisecond clock (performance.now). */
  clock?: () => number;
}

export type SyncResult =
  | { status: 'ok'; sent: number }
  | { status: 'skipped'; reason: 'no-transport' | 'no-consent' | 'nothing-to-sync' }
  | { status: 'error'; error: string; sent: number };

export interface DeleteResult {
  local: true;
  /** `skipped` when no cloud transport (or nothing to delete there) is configured. */
  cloud: 'deleted' | 'skipped' | 'failed';
}

export interface PizzaCore {
  /** `memory` means data will not survive a reload (IndexedDB unavailable). */
  readonly storageMode: StorageMode | 'custom';
  exercises: { list(): Promise<readonly Exercise[]> };
  sessions: {
    save(input: SessionInput): Promise<StoredSession>;
    list(range?: DateRange): Promise<StoredSession[]>;
  };
  consent: {
    get(purpose: ConsentPurpose): Promise<ConsentRecord | null>;
    list(): Promise<ConsentRecord[]>;
    set(purpose: ConsentPurpose, granted: boolean): Promise<ConsentRecord>;
  };
  pose: {
    /**
     * Opens the camera, runs the exercise and reports events through `handlers`.
     * Rejects if the exercise is unknown, no backend is configured, or the camera/model fails.
     */
    start(
      video: HTMLVideoElement,
      exerciseId: string,
      handlers?: PoseHandlers,
      options?: PoseStartOptions,
    ): Promise<PoseController>;
  };
  sync: { flush(): Promise<SyncResult> };
  data: {
    exportAll(): Promise<ExportedData>;
    deleteAll(): Promise<DeleteResult>;
  };
}

const BATCH_SIZE = 50;
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function createPizzaCore(options: PizzaCoreOptions = {}): Promise<PizzaCore> {
  const opened = options.storage
    ? { storage: options.storage, mode: 'custom' as const }
    : await openStorage();
  const storage = opened.storage;
  const transport = options.transport;
  const uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const textVersion = options.consentTextVersion ?? 'v1';
  const exercises = options.exercises ?? DEFAULT_EXERCISES;
  const makeBackend =
    options.createPoseBackend ??
    (options.vision && options.assets
      ? () =>
          createMediaPipeBackend({
            vision: options.vision as VisionModule,
            wasmPath: (options.assets as { wasmPath: string }).wasmPath,
            modelPath: (options.assets as { modelPath: string }).modelPath,
          })
      : undefined);

  const api: PizzaCore = {
    storageMode: opened.mode,
    exercises: { list: async () => exercises },

    sessions: {
      async save(input) {
        const valid = parseSessionInput(input);
        const clientId = valid.clientId ?? uuid();
        const stored: StoredSession = {
          clientId,
          exerciseId: valid.exerciseId,
          startedAt: valid.startedAt,
          durationS: valid.durationS,
          reps: valid.reps,
          status: valid.status,
          syncedAt: null,
        };
        const inserted = await storage.putSession(stored);
        if (inserted) return stored;
        return (await storage.getSession(clientId)) ?? stored;
      },
      list: (range) => storage.listSessions(range),
    },

    consent: {
      get: (purpose) => storage.getConsent(purpose),
      list: () => storage.listConsents(),
      async set(purpose, granted) {
        const at = now().toISOString();
        const previous = await storage.getConsent(purpose);
        const record: ConsentRecord = granted
          ? { purpose, granted: true, textVersion, grantedAt: at, revokedAt: null }
          : {
              purpose,
              granted: false,
              textVersion,
              grantedAt: previous?.grantedAt ?? null,
              revokedAt: at,
            };
        await storage.setConsent(record);
        // Fire and forget: a slow or offline network must never stall the UI. flush() re-sends.
        void transport?.sendConsents?.([record])?.catch(() => {});
        return record;
      },
    },

    pose: {
      async start(video, exerciseId, handlers = {}, startOptions = {}) {
        const exercise = exercises.find((e) => e.id === exerciseId);
        if (!exercise) throw new Error(`Unknown exercise: ${exerciseId}`);
        if (!makeBackend) {
          throw new Error('No pose backend configured: pass createPoseBackend, or vision + assets');
        }
        return startPoseController({
          backend: makeBackend(),
          exercise,
          video,
          handlers,
          messages: options.messages ?? EN_MESSAGES,
          scheduler: options.scheduler ?? defaultScheduler,
          clock: options.clock ?? (() => globalThis.performance.now()),
          now,
          save: (input) => api.sessions.save(input),
          autoSave: startOptions.autoSave ?? true,
        });
      },
    },

    sync: {
      async flush() {
        if (!transport) return { status: 'skipped', reason: 'no-transport' };

        // Keep the server's view of consent in step first - revocations included - so it can
        // enforce them even when nothing is uploaded.
        if (transport.sendConsents) {
          const all = await storage.listConsents();
          if (all.length > 0) {
            try {
              await transport.sendConsents(all);
            } catch {
              // best effort; an upload that needs the consent will report consent-required
            }
          }
        }
        const consent = await storage.getConsent('sync_sessions');
        if (!consent?.granted) return { status: 'skipped', reason: 'no-consent' };

        const pending = await storage.listUnsynced();
        if (pending.length === 0) return { status: 'skipped', reason: 'nothing-to-sync' };

        let sent = 0;
        for (let i = 0; i < pending.length; i += BATCH_SIZE) {
          const batch = pending.slice(i, i + BATCH_SIZE);
          try {
            const { acceptedIds } = await transport.sendSessions(batch);
            await storage.markSynced(acceptedIds, now().toISOString());
            sent += acceptedIds.length;
          } catch (e) {
            return { status: 'error', error: messageOf(e), sent };
          }
        }
        return { status: 'ok', sent };
      },
    },

    data: {
      async exportAll() {
        return {
          exportedAt: now().toISOString(),
          sessions: await storage.listSessions(),
          consents: await storage.listConsents(),
        };
      },
      async deleteAll() {
        let cloud: DeleteResult['cloud'] = 'skipped';
        if (transport?.deleteMyData) {
          try {
            await transport.deleteMyData();
            cloud = 'deleted';
          } catch {
            cloud = 'failed';
          }
        }
        await storage.clearAll();
        return { local: true, cloud };
      },
    },
  };
  return api;
}
