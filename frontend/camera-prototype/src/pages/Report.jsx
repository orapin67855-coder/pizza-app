import { loadSessions } from '../lib/store.js'
import { MOVES } from '../data/moves.js'
export default function Report() {
  const all = loadSessions().slice(-10).reverse()
  return (<><h1>Exercise results</h1><p className="sub">Stored on this device only</p>
    {!all.length && <div className="card">No data yet. Try your first exercise</div>}
    {all.map((s, i) => (<div className="card" key={i}><b>{MOVES.find(m => m.id === s.moveId)?.name}</b>
      <div className="sub">{new Date(s.at).toLocaleString('en-US')} · {s.reps} reps</div>
      <div className="bar"><i style={{ width: s.accuracy + '%' }} /></div>Accuracy {s.accuracy}%</div>))}
    {/* TODO: send summary numbers to the physiotherapist/relatives (requires a backend + PDPA consent) */}</>)
}
