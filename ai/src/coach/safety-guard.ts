export type TrackingQuality = 'good' | 'fair' | 'poor';
export type SafetyAction = 'continue' | 'pause' | 'stop';
export type SafetyReason =
  'user-stop' | 'carer-not-confirmed' | 'camera-stopped' | 'person-lost' | 'low-tracking';

export interface SafetyFrame {
  timestampMs: number;
  personDetected: boolean;
  /** Lowest visibility among the landmarks the exercise needs (0..1). */
  visibility: number;
  cameraActive: boolean;
}

export interface SafetyDecision {
  action: SafetyAction;
  reason?: SafetyReason;
  quality: TrackingQuality;
}

export interface SafetyGuardOptions {
  needsCarer: boolean;
  /** Pause after the person has been missing this long. Default 2000 ms. */
  lostPersonMs?: number;
  /** Pause after tracking has been poor this long. Default 3000 ms. */
  lowTrackingMs?: number;
  /** Below this a frame is "poor". Default 0.5. */
  minVisibility?: number;
}

export interface SafetyGuard {
  evaluate(frame: SafetyFrame): SafetyDecision;
  confirmCarer(): void;
  /** Latched: stays stopped until reset(). */
  requestStop(): void;
  reset(): void;
}

const GOOD_VISIBILITY = 0.8;

/**
 * Decides, frame by frame, whether the exercise may continue. When unsure it pauses or
 * stops - it never guesses. It does NOT detect falls, freezing or any medical event.
 */
export function createSafetyGuard(options: SafetyGuardOptions): SafetyGuard {
  const lostPersonMs = options.lostPersonMs ?? 2000;
  const lowTrackingMs = options.lowTrackingMs ?? 3000;
  const minVisibility = options.minVisibility ?? 0.5;

  let carerConfirmed = false;
  let stopRequested = false;
  let lostSince: number | null = null;
  let poorSince: number | null = null;

  const rate = (frame: SafetyFrame): TrackingQuality => {
    if (!frame.personDetected) return 'poor';
    if (frame.visibility >= GOOD_VISIBILITY) return 'good';
    if (frame.visibility >= minVisibility) return 'fair';
    return 'poor';
  };

  return {
    evaluate(frame) {
      const quality = rate(frame);
      const t = frame.timestampMs;

      if (stopRequested) return { action: 'stop', reason: 'user-stop', quality };
      if (options.needsCarer && !carerConfirmed) {
        return { action: 'stop', reason: 'carer-not-confirmed', quality };
      }
      if (!frame.cameraActive) {
        lostSince = null;
        poorSince = null;
        return { action: 'stop', reason: 'camera-stopped', quality };
      }

      if (!frame.personDetected) {
        poorSince = null;
        lostSince ??= t;
        if (t - lostSince >= lostPersonMs) {
          return { action: 'pause', reason: 'person-lost', quality };
        }
        return { action: 'continue', quality };
      }
      lostSince = null;

      if (quality === 'poor') {
        poorSince ??= t;
        if (t - poorSince >= lowTrackingMs) {
          return { action: 'pause', reason: 'low-tracking', quality };
        }
      } else {
        poorSince = null;
      }
      return { action: 'continue', quality };
    },
    confirmCarer() {
      carerConfirmed = true;
    },
    requestStop() {
      stopRequested = true;
    },
    reset() {
      stopRequested = false;
      lostSince = null;
      poorSince = null;
    },
  };
}
