import { useRef, useState } from 'react'
import { usePose } from '../hooks/usePose.js'
import { armRaiseAngle, makeCounter } from '../lib/pose.js'
import { saveSession, speak } from '../lib/store.js'
export default function Practice({ move, go }) {
  const video = useRef(), counter = useRef(null), last = useRef(0)
  const [ok, setOk] = useState(!move?.needsCarer), [run, setRun] = useState(false)
  const [s, setS] = useState({ reps: 0, msg: 'Ready to start', angle: 0 })
  const status = usePose(video, lm => {
    // MVP supports only the arm raise; add other exercises in src/lib/pose.js according to move.metric
    const { avg } = armRaiseAngle(lm)
    counter.current ||= makeCounter(move.targetAngle)
    const r = counter.current(avg)
    const msg = avg < move.targetAngle - 20 ? 'Raise your arms a little higher' : 'Great, hold it'
    if (r.reps !== last.current) { last.current = r.reps; speak(`Rep ${r.reps}`) }
    setS({ reps: r.reps, msg, angle: Math.round(avg) })
    if (r.reps >= move.reps) finish(r)
  }, run && !!move)
  if (!move) return <><p>Choose an exercise first</p><button onClick={() => go('moves')}>Choose exercise</button></>
  function finish(r) {
    const acc = r.scores.length ? Math.round(r.scores.reduce((a, b) => a + b) / r.scores.length) : 0
    saveSession({ moveId: move.id, reps: r.reps, accuracy: acc }); setRun(false); speak('All done, well done'); go('report')
  }
  if (!ok) return (<><h1>Before you start</h1><div className="note">This exercise carries a fall risk and needs a carer nearby</div>
    <button className="full" onClick={() => setOk(true)}>A carer is nearby</button></>)
  return (<>
    <h1>{move.name}</h1>
    <div className={'cam ' + (s.msg.startsWith('Great') ? 'good' : '')}>
      <video ref={video} playsInline muted /><b>{status === 'loading' ? 'Loading camera…' : status === 'error' ? 'Cannot open the camera' : s.msg}</b></div>
    <div className="row"><div className="card grow c">Rep<br /><big>{s.reps}/{move.reps}</big></div><div className="card grow c">Arm angle<br /><big>{s.angle}°</big></div></div>
    {!run ? <button className="full" onClick={() => setRun(true)}>Open camera and start</button>
      : <button className="btn line full" onClick={() => setRun(false)}>Take a break</button>}
    {/* TODO: detect freezing/loss of balance, then stop the exercise and notify the carer (later phase) */}
  </>)
}
