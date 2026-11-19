import { MOVES } from '../data/moves.js'
const yt = q => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q)
export default function Moves({ go, pick, move }) {
  if (!move) return (<>
    <h1>Exercises</h1><p className="sub">Tap an exercise to preview it before practicing</p>
    {MOVES.map(m => (<div className="card" key={m.id}><b>{m.name}</b>
      <div><span className={'pill' + (m.needsCarer ? ' w' : '')}>{m.needsCarer ? 'Carer required' : m.group}</span></div>
      <button onClick={() => pick(m)}>Preview</button></div>))}</>)
  return (<>
    <button className="back" onClick={() => pick(null)}>‹ Back</button><h1>{move.name}</h1>
    <ol className="steps">{move.steps.map(s => <li key={s}>{s}</li>)}</ol>
    {/* TODO: embed a physiotherapist-approved tutorial clip: <video src=... controls> instead of the search link */}
    <a className="btn line full" href={yt(move.clipQuery)} target="_blank" rel="noopener noreferrer">▶ Watch tutorial on YouTube</a>
    <a className="btn line full" href="https://www.chulapd.org/" target="_blank" rel="noopener noreferrer">Knowledge from Chulalongkorn Parkinson Center</a>
    {move.needsCarer && <div className="note">This exercise needs a carer nearby. Please confirm before you start</div>}
    <button className="full" onClick={() => go('practice')}>Start with camera</button>
  </>)
}
