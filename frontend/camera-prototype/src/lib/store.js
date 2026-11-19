// Store session results on the device (localStorage); in future only summary numbers are sent to the backend
const K = 'pizza.sessions'
export const loadSessions = () => { try { return JSON.parse(localStorage.getItem(K) || '[]') } catch { return [] } }
export function saveSession(s) { localStorage.setItem(K, JSON.stringify([...loadSessions(), { ...s, at: new Date().toISOString() }])) }
export const speak = (t) => { try { const u = new SpeechSynthesisUtterance(t); u.lang = 'en-US'; speechSynthesis.cancel(); speechSynthesis.speak(u) } catch {} }
