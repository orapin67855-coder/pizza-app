import { describe, expect, it } from 'vitest';
import { cueForFrame } from '../src/coach/cues';
import { EN_MESSAGES } from '../src/coach/messages/en';

const base = { up: 25, down: 10, phase: 'waiting' as const, value: NaN };

describe('cueForFrame: calibrating', () => {
  it('asks the user to stay still while the resting posture is being learned', () => {
    expect(cueForFrame({ ...base, action: 'continue', calibrating: true })).toBe('calibrating');
  });

  it('has a plain, non-clinical message', () => {
    expect(EN_MESSAGES.calibrating).toMatch(/still/i);
  });

  it('is overridden by safety cues', () => {
    expect(
      cueForFrame({ ...base, action: 'pause', reason: 'person-lost', calibrating: true }),
    ).toBe('person_lost');
  });

  it('does not appear once calibration is done', () => {
    expect(
      cueForFrame({ ...base, phase: 'rest', value: 0, action: 'continue', calibrating: false }),
    ).toBeNull();
  });
});
