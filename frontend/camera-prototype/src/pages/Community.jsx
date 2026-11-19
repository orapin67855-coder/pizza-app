// Prototype: no upload/video playback yet; a backend and content moderation still need to be added
const CLIPS = [{ t: 'Seated Thai dance, morning session', by: 'Uncle Somchai', sync: 86, checked: true }, { t: 'Walking to the beat with daughter', by: 'Auntie Wilai', sync: null, checked: false }]
export default function Community() {
  return (<><h1>PIZZA Moves</h1><p className="sub">Therapeutic dance clips from the community (sample)</p>
    {CLIPS.map(c => (<div className="card" key={c.t}><b>{c.t}</b><div className="sub">{c.by}</div>
      {c.sync && <span className="pill">Rhythm match {c.sync}%</span>} <span className={'pill' + (c.checked ? '' : ' w')}>{c.checked ? 'Reviewed by physiotherapist' : 'Pending review'}</span></div>))}
    <div className="note">Default "Visible only to me" and PDPA consent is required before sharing</div></>)
}
