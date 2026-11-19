// Angle at point b between lines b→a and b→c (degrees) from landmark {x,y}
export function angle(a, b, c) {
  const r = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x)
  const d = Math.abs((r * 180) / Math.PI)
  return d > 180 ? 360 - d : d
}
// MediaPipe landmark index: 11/12 shoulders L/R, 13/14 elbows, 15/16 wrists, 23/24 hips, 25/26 knees, 27/28 ankles
export function armRaiseAngle(lm) {
  const l = angle(lm[23], lm[11], lm[15]), r = angle(lm[24], lm[12], lm[16])
  return { l, r, avg: (l + r) / 2, symmetry: 100 - Math.min(100, Math.abs(l - r)) }
}
// Rep counter: a rep counts when the angle reaches the target and then drops below 40 degrees; keeps the peak angle of each rep
export function makeCounter(target) {
  let up = false, peak = 0, reps = 0
  const scores = []
  return (a) => {
    peak = Math.max(peak, a)
    if (!up && a >= target) up = true
    if (up && a < 40) { reps++; scores.push(Math.min(100, Math.round((peak / target) * 100))); up = false; peak = 0 }
    return { reps, scores: [...scores], peak }
  }
}
