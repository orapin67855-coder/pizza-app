import { describe, expect, it } from 'vitest';
import * as api from '../src/index';

describe('default exercises', () => {
  it('have unique ids and valid thresholds', () => {
    const ids = api.DEFAULT_EXERCISES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of api.DEFAULT_EXERCISES) {
      expect(e.criteria.up, e.id).toBeGreaterThan(e.criteria.down);
      expect(e.criteria.minRepMs, e.id).toBeGreaterThanOrEqual(0);
      expect(e.targetReps, e.id).toBeGreaterThan(0);
    }
  });

  it('are all drafts until a physiotherapist approves them', () => {
    expect(api.DEFAULT_EXERCISES.every((e) => e.approvalStatus === 'draft')).toBe(true);
  });

  it('require a carer for sit-to-stand (fall risk)', () => {
    const sts = api.DEFAULT_EXERCISES.find((e) => e.id === 'sit-stand');
    expect(sts?.needsCarer).toBe(true);
  });

  it('can each be run in a pose session', () => {
    for (const exercise of api.DEFAULT_EXERCISES) {
      expect(() => api.createPoseSession({ exercise })).not.toThrow();
    }
  });
});

describe('public API surface', () => {
  it('exposes the pieces the UI adapter needs', () => {
    for (const name of [
      'createPoseSession',
      'createSafetyGuard',
      'createRepCounter',
      'createOneEuroFilter',
      'createMedianFilter',
      'jointAngle',
      'extractSignal',
      'cueForFrame',
      'EN_MESSAGES',
      'LANDMARK',
      'DEFAULT_EXERCISES',
      'createPizzaCore',
      'openStorage',
      'createMediaPipeBackend',
      'createSupabaseTransport',
      'CONSENT_PURPOSES',
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });
});
