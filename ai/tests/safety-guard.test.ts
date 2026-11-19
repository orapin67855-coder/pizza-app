import { describe, expect, it } from 'vitest';
import { createSafetyGuard } from '../src/coach/safety-guard';

const ok = (t: number, visibility = 0.95) => ({
  timestampMs: t,
  personDetected: true,
  visibility,
  cameraActive: true,
});
const lost = (t: number) => ({
  timestampMs: t,
  personDetected: false,
  visibility: 0,
  cameraActive: true,
});

describe('createSafetyGuard: carer confirmation', () => {
  it('stops an exercise that needs a carer until one is confirmed', () => {
    const g = createSafetyGuard({ needsCarer: true });
    expect(g.evaluate(ok(0))).toMatchObject({ action: 'stop', reason: 'carer-not-confirmed' });
  });

  it('continues once the carer is confirmed', () => {
    const g = createSafetyGuard({ needsCarer: true });
    g.confirmCarer();
    expect(g.evaluate(ok(0)).action).toBe('continue');
  });

  it('does not ask for a carer when the exercise does not need one', () => {
    const g = createSafetyGuard({ needsCarer: false });
    expect(g.evaluate(ok(0)).action).toBe('continue');
  });
});

describe('createSafetyGuard: user stop', () => {
  it('stops immediately when the user asks, whatever the frame looks like', () => {
    const g = createSafetyGuard({ needsCarer: false });
    g.requestStop();
    expect(g.evaluate(ok(0))).toMatchObject({ action: 'stop', reason: 'user-stop' });
  });

  it('stays stopped on later healthy frames (latched)', () => {
    const g = createSafetyGuard({ needsCarer: false });
    g.requestStop();
    g.evaluate(ok(0));
    expect(g.evaluate(ok(1000)).action).toBe('stop');
  });

  it('can be re-armed with reset()', () => {
    const g = createSafetyGuard({ needsCarer: false });
    g.requestStop();
    g.reset();
    expect(g.evaluate(ok(0)).action).toBe('continue');
  });

  it('takes priority over the carer check', () => {
    const g = createSafetyGuard({ needsCarer: true });
    g.requestStop();
    expect(g.evaluate(ok(0)).reason).toBe('user-stop');
  });
});

describe('createSafetyGuard: camera', () => {
  it('stops when the camera is no longer active', () => {
    const g = createSafetyGuard({ needsCarer: false });
    expect(g.evaluate({ ...ok(0), cameraActive: false })).toMatchObject({
      action: 'stop',
      reason: 'camera-stopped',
    });
  });

  it('continues again once the camera is back', () => {
    const g = createSafetyGuard({ needsCarer: false });
    g.evaluate({ ...ok(0), cameraActive: false });
    expect(g.evaluate(ok(100)).action).toBe('continue');
  });
});

describe('createSafetyGuard: person lost', () => {
  it('keeps going for a short drop-out', () => {
    const g = createSafetyGuard({ needsCarer: false, lostPersonMs: 2000 });
    g.evaluate(ok(0));
    expect(g.evaluate(lost(1000)).action).toBe('continue');
    expect(g.evaluate(lost(1900)).action).toBe('continue');
  });

  it('pauses once the person has been missing for lostPersonMs', () => {
    const g = createSafetyGuard({ needsCarer: false, lostPersonMs: 2000 });
    g.evaluate(ok(0));
    g.evaluate(lost(1000));
    expect(g.evaluate(lost(3000))).toMatchObject({ action: 'pause', reason: 'person-lost' });
  });

  it('resumes when the person comes back', () => {
    const g = createSafetyGuard({ needsCarer: false, lostPersonMs: 2000 });
    g.evaluate(lost(0));
    g.evaluate(lost(2500));
    expect(g.evaluate(ok(2600)).action).toBe('continue');
  });

  it('restarts the timer if the person briefly returns', () => {
    const g = createSafetyGuard({ needsCarer: false, lostPersonMs: 2000 });
    g.evaluate(lost(0));
    g.evaluate(lost(1500));
    g.evaluate(ok(1600));
    expect(g.evaluate(lost(2500)).action).toBe('continue');
    expect(g.evaluate(lost(3700)).action).toBe('continue');
    expect(g.evaluate(lost(4600)).action).toBe('pause');
  });
});

describe('createSafetyGuard: tracking quality', () => {
  it('rates visibility as good, fair or poor', () => {
    const g = createSafetyGuard({ needsCarer: false, minVisibility: 0.5 });
    expect(g.evaluate(ok(0, 0.9)).quality).toBe('good');
    expect(g.evaluate(ok(33, 0.6)).quality).toBe('fair');
    expect(g.evaluate(ok(66, 0.3)).quality).toBe('poor');
  });

  it('rates a missing person as poor', () => {
    const g = createSafetyGuard({ needsCarer: false });
    expect(g.evaluate(lost(0)).quality).toBe('poor');
  });

  it('pauses after poor tracking persists for lowTrackingMs', () => {
    const g = createSafetyGuard({ needsCarer: false, lowTrackingMs: 3000, minVisibility: 0.5 });
    g.evaluate(ok(0, 0.3));
    expect(g.evaluate(ok(2900, 0.3)).action).toBe('continue');
    expect(g.evaluate(ok(3100, 0.3))).toMatchObject({ action: 'pause', reason: 'low-tracking' });
  });

  it('resumes when tracking recovers', () => {
    const g = createSafetyGuard({ needsCarer: false, lowTrackingMs: 3000, minVisibility: 0.5 });
    g.evaluate(ok(0, 0.3));
    g.evaluate(ok(3100, 0.3));
    expect(g.evaluate(ok(3200, 0.9)).action).toBe('continue');
  });
});
