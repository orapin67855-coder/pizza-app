import type { Landmark } from '../types/landmark';

/**
 * Minimal structural view of `@mediapipe/tasks-vision` (pin 0.10.14, decision D1). The caller
 * injects the real module, so this package never bundles MediaPipe and stays testable.
 *
 *   import * as vision from '@mediapipe/tasks-vision';
 *   createMediaPipeBackend({ vision, wasmPath: '/vendor/mediapipe/wasm', modelPath: '...task' })
 */
export interface LandmarkerLike {
  detectForVideo(video: HTMLVideoElement, timestampMs: number): { landmarks: Landmark[][] };
  close(): void;
}

export interface VisionModule {
  FilesetResolver: { forVisionTasks(wasmPath: string): Promise<unknown> };
  PoseLandmarker: {
    createFromOptions(
      fileset: unknown,
      options: {
        baseOptions: { modelAssetPath: string };
        runningMode: 'VIDEO';
        numPoses: number;
      },
    ): Promise<LandmarkerLike>;
  };
}

export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface MediaPipeBackendOptions {
  vision: VisionModule;
  /** URL of the self-hosted MediaPipe `wasm` folder (no CDN). */
  wasmPath: string;
  /** URL of the self-hosted `pose_landmarker_lite.task` model. */
  modelPath: string;
  /** Defaults to `navigator.mediaDevices`. */
  mediaDevices?: MediaDevicesLike;
  facingMode?: 'user' | 'environment';
}

export interface PoseBackend {
  /** Opens the camera and loads the model. Rejects (and releases everything) on failure. */
  start(video: HTMLVideoElement): Promise<void>;
  /**
   * - `Landmark[]`: the first person's landmarks for a new frame
   * - `null`: a new frame was analysed and nobody was found
   * - `undefined`: no new frame to analyse yet (video not ready, or same frame as last call)
   */
  detect(timestampMs: number): Landmark[] | null | undefined;
  /** False before start, after stop, or if the camera stream has ended. */
  readonly cameraActive: boolean;
  /** Releases camera and model. Safe to call repeatedly. */
  stop(): void;
}

const HAVE_CURRENT_DATA = 2;
type State = 'idle' | 'starting' | 'running' | 'stopped';

export function createMediaPipeBackend(options: MediaPipeBackendOptions): PoseBackend {
  let state: State = 'idle';
  let stream: MediaStream | null = null;
  let landmarker: LandmarkerLike | null = null;
  let video: HTMLVideoElement | null = null;
  let lastVideoTime = -1;

  const release = () => {
    stream?.getTracks().forEach((t) => t.stop());
    landmarker?.close();
    if (video) video.srcObject = null;
    stream = null;
    landmarker = null;
    video = null;
    lastVideoTime = -1;
  };

  return {
    async start(target) {
      if (state === 'starting' || state === 'running') throw new Error('Backend already started');
      state = 'starting';
      try {
        const devices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
        if (!devices) throw new Error('Camera API not available (needs HTTPS or localhost)');

        stream = await devices.getUserMedia({
          video: { facingMode: options.facingMode ?? 'user' },
          audio: false,
        });
        video = target;
        target.srcObject = stream;
        await target.play();

        const fileset = await options.vision.FilesetResolver.forVisionTasks(options.wasmPath);
        landmarker = await options.vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: options.modelPath },
          runningMode: 'VIDEO',
          numPoses: 1,
        });
        state = 'running';
      } catch (error) {
        release();
        state = 'idle';
        throw error;
      }
    },

    detect(timestampMs) {
      if (state === 'idle' || state === 'starting') throw new Error('Backend not started');
      if (state === 'stopped' || !landmarker || !video) return null;
      if (video.readyState < HAVE_CURRENT_DATA || video.currentTime === lastVideoTime) {
        return undefined;
      }
      lastVideoTime = video.currentTime;
      return landmarker.detectForVideo(video, timestampMs).landmarks[0] ?? null;
    },

    get cameraActive() {
      if (state !== 'running' || !stream) return false;
      const tracks = stream.getVideoTracks();
      return tracks.length > 0 && tracks.every((t) => t.readyState === 'live');
    },

    stop() {
      if (state !== 'running') return;
      release();
      state = 'stopped';
    },
  };
}
