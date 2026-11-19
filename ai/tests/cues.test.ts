import { describe, expect, it } from 'vitest';
import { cueForFrame } from '../src/coach/cues';
import { EN_MESSAGES } from '../src/coach/messages/en';

const base = { up: 150, down: 40 };

describe('cueForFrame', () => {
  it('asks the user to get into the start position while waiting', () => {
    expect(cueForFrame({ ...base, phase: 'waiting', value: 120, action: 'continue' })).toBe(
      'get_into_start_position',
    );
  });

  it('says nothing at rest near the start position', () => {
    expect(cueForFrame({ ...base, phase: 'rest', value: 20, action: 'continue' })).toBeNull();
  });

  it('encourages reaching higher once past halfway but short of the target', () => {
    expect(cueForFrame({ ...base, phase: 'rest', value: 110, action: 'continue' })).toBe(
      'reach_higher',
    );
  });

  it('asks to hold and then lower slowly when the target is reached', () => {
    expect(cueForFrame({ ...base, phase: 'up', value: 160, action: 'continue' })).toBe(
      'hold_then_lower',
    );
  });

  it('prefers a safety cue over a coaching cue', () => {
    expect(
      cueForFrame({
        ...base,
        phase: 'up',
        value: 160,
        action: 'pause',
        reason: 'person-lost',
      }),
    ).toBe('person_lost');
  });

  it('maps each safety reason to its own cue', () => {
    const f = (reason: string, action: 'pause' | 'stop') =>
      cueForFrame({
        ...base,
        phase: 'rest',
        value: 0,
        action,
        reason: reason as never,
      });
    expect(f('low-tracking', 'pause')).toBe('low_tracking');
    expect(f('carer-not-confirmed', 'stop')).toBe('carer_required');
    expect(f('camera-stopped', 'stop')).toBe('camera_stopped');
    expect(f('user-stop', 'stop')).toBe('stopped');
  });

  it('gives no coaching cue when the value is not a number', () => {
    expect(cueForFrame({ ...base, phase: 'rest', value: NaN, action: 'continue' })).toBeNull();
  });
});

describe('EN_MESSAGES', () => {
  it('has a non-empty message for every cue key used', () => {
    for (const [key, text] of Object.entries(EN_MESSAGES)) {
      expect(text.trim().length, key).toBeGreaterThan(0);
    }
  });

  it('never uses clinical or prohibited wording (see AGENTS.md section 6)', () => {
    const banned = /\b(cure|heal|treat(ment)?|diagnos\w*|freez\w*|prevent\w* falls?|detect\w*)\b/i;
    for (const [key, text] of Object.entries(EN_MESSAGES)) {
      expect(text, key).not.toMatch(banned);
    }
  });
});
