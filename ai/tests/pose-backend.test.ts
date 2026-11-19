import { describe, expect, it, vi } from 'vitest';
import {
  createMediaPipeBackend,
  type MediaDevicesLike,
  type VisionModule,
} from '../src/core/pose-backend';
import type { Landmark } from '../src/types/landmark';

const person: Landmark[] = [{ x: 0.1, y: 0.2, z: 0, visibility: 0.9 }];

interface FakeTrack {
  readyState: 'live' | 'ended';
  stop: ReturnType<typeof vi.fn>;
}

function setup(
  over: { landmarks?: Landmark[][]; camera?: 'ok' | 'denied'; model?: 'ok' | 'fail' } = {},
) {
  const tracks: FakeTrack[] = [{ readyState: 'live', stop: vi.fn() }];
  const stream = { getVideoTracks: () => tracks, getTracks: () => tracks };
  const getUserMedia = vi.fn(async () => {
    if (over.camera === 'denied') throw new Error('NotAllowedError');
    return stream as unknown as MediaStream;
  });
  const mediaDevices: MediaDevicesLike = { getUserMedia };

  const landmarker = {
    detectForVideo: vi.fn(() => ({ landmarks: over.landmarks ?? [person] })),
    close: vi.fn(),
  };
  const fileset = { wasm: true };
  const forVisionTasks = vi.fn(async () => fileset);
  const createFromOptions = vi.fn(async () => {
    if (over.model === 'fail') throw new Error('model not found');
    return landmarker;
  });
  const vision: VisionModule = {
    FilesetResolver: { forVisionTasks },
    PoseLandmarker: { createFromOptions },
  };

  const video = {
    srcObject: null as unknown,
    readyState: 4,
    currentTime: 0,
    play: vi.fn(async () => {}),
  };

  const backend = createMediaPipeBackend({
    vision,
    wasmPath: '/vendor/mediapipe/wasm',
    modelPath: '/vendor/mediapipe/pose_landmarker_lite.task',
    mediaDevices,
  });
  return {
    backend,
    video: video as unknown as HTMLVideoElement,
    rawVideo: video,
    tracks,
    stream,
    landmarker,
    forVisionTasks,
    createFromOptions,
    getUserMedia,
    fileset,
  };
}

describe('createMediaPipeBackend: start', () => {
  it('loads wasm and model from the self-hosted paths in video mode for one person', async () => {
    const t = setup();
    await t.backend.start(t.video);
    expect(t.forVisionTasks).toHaveBeenCalledWith('/vendor/mediapipe/wasm');
    expect(t.createFromOptions).toHaveBeenCalledWith(t.fileset, {
      baseOptions: { modelAssetPath: '/vendor/mediapipe/pose_landmarker_lite.task' },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
  });

  it('asks for video only (never audio) and plays it', async () => {
    const t = setup();
    await t.backend.start(t.video);
    expect(t.getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'user' }, audio: false });
    expect(t.rawVideo.srcObject).toBe(t.stream);
    expect(t.rawVideo.play).toHaveBeenCalledOnce();
  });

  it('rejects a second start', async () => {
    const t = setup();
    await t.backend.start(t.video);
    await expect(t.backend.start(t.video)).rejects.toThrow(/already/i);
  });

  it('surfaces a denied camera and creates no landmarker', async () => {
    const t = setup({ camera: 'denied' });
    await expect(t.backend.start(t.video)).rejects.toThrow('NotAllowedError');
    expect(t.createFromOptions).not.toHaveBeenCalled();
    expect(t.backend.cameraActive).toBe(false);
  });

  it('releases the camera if the model fails to load', async () => {
    const t = setup({ model: 'fail' });
    await expect(t.backend.start(t.video)).rejects.toThrow('model not found');
    expect(t.tracks[0]?.stop).toHaveBeenCalled();
    expect(t.rawVideo.srcObject).toBeNull();
  });
});

describe('createMediaPipeBackend: detect', () => {
  it('returns the landmarks of the first person', async () => {
    const t = setup();
    await t.backend.start(t.video);
    t.rawVideo.currentTime = 1;
    expect(t.backend.detect(1000)).toEqual(person);
    expect(t.landmarker.detectForVideo).toHaveBeenCalledWith(t.video, 1000);
  });

  it('returns null when nobody is in view', async () => {
    const t = setup({ landmarks: [] });
    await t.backend.start(t.video);
    t.rawVideo.currentTime = 1;
    expect(t.backend.detect(1000)).toBeNull();
  });

  it('returns undefined (no new frame) while the video is not ready', async () => {
    const t = setup();
    await t.backend.start(t.video);
    t.rawVideo.readyState = 1;
    t.rawVideo.currentTime = 1;
    expect(t.backend.detect(1000)).toBeUndefined();
    expect(t.landmarker.detectForVideo).not.toHaveBeenCalled();
  });

  it('does not analyse the same video frame twice', async () => {
    const t = setup();
    await t.backend.start(t.video);
    t.rawVideo.currentTime = 1;
    t.backend.detect(1000);
    expect(t.backend.detect(1016)).toBeUndefined();
    t.rawVideo.currentTime = 1.033;
    expect(t.backend.detect(1033)).toEqual(person);
    expect(t.landmarker.detectForVideo).toHaveBeenCalledTimes(2);
  });

  it('throws if used before start', () => {
    const t = setup();
    expect(() => t.backend.detect(0)).toThrow(/not started/i);
  });
});

describe('createMediaPipeBackend: camera state and stop', () => {
  it('is not active before start, active while tracks are live, inactive once one ends', async () => {
    const t = setup();
    expect(t.backend.cameraActive).toBe(false);
    await t.backend.start(t.video);
    expect(t.backend.cameraActive).toBe(true);
    (t.tracks[0] as FakeTrack).readyState = 'ended';
    expect(t.backend.cameraActive).toBe(false);
  });

  it('stop releases the camera and the model and detaches the video', async () => {
    const t = setup();
    await t.backend.start(t.video);
    t.backend.stop();
    expect(t.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(t.landmarker.close).toHaveBeenCalledOnce();
    expect(t.rawVideo.srcObject).toBeNull();
    expect(t.backend.cameraActive).toBe(false);
  });

  it('stop is safe to call twice or before start', async () => {
    const t = setup();
    t.backend.stop();
    await t.backend.start(t.video);
    t.backend.stop();
    t.backend.stop();
    expect(t.landmarker.close).toHaveBeenCalledOnce();
  });

  it('detect after stop returns null instead of touching a closed model', async () => {
    const t = setup();
    await t.backend.start(t.video);
    t.backend.stop();
    expect(t.backend.detect(2000)).toBeNull();
    expect(t.landmarker.detectForVideo).not.toHaveBeenCalled();
  });

  it('can be started again after a stop', async () => {
    const t = setup();
    await t.backend.start(t.video);
    t.backend.stop();
    await expect(t.backend.start(t.video)).resolves.toBeUndefined();
  });
});
