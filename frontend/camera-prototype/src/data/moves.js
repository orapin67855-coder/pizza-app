// Physiotherapists edit exercises and thresholds in this file (should later move to a database)
export const MOVES = [
  { id: 'arm-raise', name: 'High arm raise', group: 'Wide movements', needsCarer: false,
    metric: 'shoulder-angle', targetAngle: 150, reps: 10,
    steps: ['Sit upright with feet flat on the floor', 'Raise both arms overhead as high as you can', 'Hold for a count of 1–2, then lower slowly', 'Do 10 reps'],
    clipQuery: 'LSVT BIG exercises Parkinson seated big arm raise' },
  { id: 'sit-stand', name: 'Sit-to-stand from a chair', group: 'Sit-to-stand', needsCarer: true,
    metric: 'knee-angle', targetAngle: 160, reps: 5,
    steps: ['Use a stable chair without wheels, against a wall', 'Lean forward and push through your feet to stand up fully', 'Stand still for 1 second, then sit down slowly', 'Do 5 reps'],
    clipQuery: 'sit to stand exercise Parkinson disease physiotherapy' },
  { id: 'big-step', name: 'Long steps, rhythmic walking', group: 'Walking', needsCarer: true,
    metric: 'step-length', targetAngle: 0, reps: 10,
    steps: ['Stand near a handrail or your carer', 'Take long steps, heel touching the floor first', 'Swing your arms opposite to your legs', 'Walk 10 steps; stop immediately if you feel stuck'],
    clipQuery: 'Parkinson walking big steps exercise physiotherapy' },
]
