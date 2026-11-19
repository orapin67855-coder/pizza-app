import { describe, expect, it } from 'vitest';
import {
  parseConsentsBody,
  parseSessionsBatch,
  ValidationError,
} from '../supabase/functions/_shared/validate.ts';

const session = (over: Record<string, unknown> = {}) => ({
  clientId: 'c-1',
  exerciseId: 'arm-raise',
  startedAt: '2026-11-18T09:00:00Z',
  durationS: 60,
  reps: 5,
  status: 'completed',
  ...over,
});

describe('parseSessionsBatch', () => {
  it('turns a valid batch into database rows with a canonical timestamp', () => {
    expect(parseSessionsBatch({ sessions: [session()] })).toEqual([
      {
        client_id: 'c-1',
        exercise_id: 'arm-raise',
        started_at: '2026-11-18T09:00:00.000Z',
        duration_s: 60,
        reps: 5,
        status: 'completed',
      },
    ]);
  });

  it('accepts exactly 50 sessions and rejects 51', () => {
    const many = (n: number) => ({
      sessions: Array.from({ length: n }, (_, i) => session({ clientId: `c-${i}` })),
    });
    expect(parseSessionsBatch(many(50))).toHaveLength(50);
    expect(() => parseSessionsBatch(many(51))).toThrow(ValidationError);
  });

  it('keeps only the first of duplicate clientIds in one batch', () => {
    const rows = parseSessionsBatch({
      sessions: [session({ reps: 1 }), session({ reps: 2 })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reps).toBe(1);
  });

  it.each([
    ['null body', null],
    ['array body', []],
    ['missing sessions', {}],
    ['sessions not an array', { sessions: 'x' }],
    ['empty sessions', { sessions: [] }],
    ['non-object session', { sessions: [1] }],
  ])('rejects %s', (_label, body) => {
    expect(() => parseSessionsBatch(body)).toThrow(ValidationError);
  });

  it.each([
    ['missing clientId', { clientId: undefined }],
    ['empty clientId', { clientId: '' }],
    ['overlong clientId', { clientId: 'x'.repeat(65) }],
    ['empty exerciseId', { exerciseId: '' }],
    ['non-UTC date', { startedAt: '2026-11-18T09:00:00+07:00' }],
    ['garbage date', { startedAt: 'yesterday' }],
    ['negative duration', { durationS: -1 }],
    ['absurd duration', { durationS: 86401 }],
    ['non-finite duration', { durationS: Infinity }],
    ['fractional reps', { reps: 2.5 }],
    ['negative reps', { reps: -1 }],
    ['absurd reps', { reps: 1001 }],
    ['unknown status', { status: 'weird' }],
  ])('rejects a session with %s', (_label, over) => {
    expect(() => parseSessionsBatch({ sessions: [session(over)] })).toThrow(ValidationError);
  });

  it('refuses unexpected fields so raw data can never reach the database', () => {
    expect(() =>
      parseSessionsBatch({ sessions: [session({ landmarks: [[{ x: 0, y: 0 }]] })] }),
    ).toThrow(/unexpected/i);
  });

  it('refuses unexpected top-level fields too', () => {
    expect(() => parseSessionsBatch({ sessions: [session()], video: 'x' })).toThrow(/unexpected/i);
  });
});

describe('parseConsentsBody', () => {
  const c = (over: Record<string, unknown> = {}) => ({
    purpose: 'sync_sessions',
    granted: true,
    textVersion: 'v1',
    ...over,
  });

  it('turns valid records into database rows', () => {
    expect(parseConsentsBody({ consents: [c()] })).toEqual([
      { purpose: 'sync_sessions', granted: true, text_version: 'v1' },
    ]);
  });

  it('accepts all four purposes at once', () => {
    const consents = ['sync_sessions', 'share_with_physio', 'community_clip', 'ai_summary'].map(
      (purpose) => c({ purpose }),
    );
    expect(parseConsentsBody({ consents })).toHaveLength(4);
  });

  it.each([
    ['empty list', { consents: [] }],
    ['not a list', { consents: 'x' }],
    ['unknown purpose', { consents: [c({ purpose: 'marketing' })] }],
    ['non-boolean granted', { consents: [c({ granted: 'yes' })] }],
    ['empty textVersion', { consents: [c({ textVersion: '' })] }],
    ['overlong textVersion', { consents: [c({ textVersion: 'v'.repeat(33) })] }],
    ['duplicate purposes', { consents: [c(), c({ granted: false })] }],
    ['client-supplied timestamps', { consents: [c({ grantedAt: '2020-01-01T00:00:00Z' })] }],
    ['extra top-level field', { consents: [c()], userId: 'someone-else' }],
  ])('rejects %s', (_label, body) => {
    expect(() => parseConsentsBody(body)).toThrow(ValidationError);
  });
});
