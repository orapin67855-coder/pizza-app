import { MOVES } from '../data/moves.js'
import { loadSessions } from '../lib/store.js'
export default function Home({ go }) {
  const day = new Date().toISOString().slice(0, 10)
  const done = new Set(loadSessions().filter(s => s.at.slice(0, 10) === day).map(s => s.moveId)).size
  return (<>
    <h1>Hello</h1><p className="sub">Done today: {done} of {MOVES.length} exercises</p>
    <div className="card"><div className="bar"><i style={{ width: `${(done / MOVES.length) * 100}%` }} /></div>
      <button className="full" onClick={() => go('moves')}>Start exercise</button></div>
    <div className="note">Balance and walking exercises always need a carer nearby</div>
  </>)
}
