/** A single pose landmark. Coordinates follow MediaPipe's normalized image space. */
export interface Landmark {
  x: number;
  y: number;
  z?: number;
  /** 0..1 confidence that the landmark is visible in the frame. */
  visibility?: number;
}
