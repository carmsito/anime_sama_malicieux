import { useCallback, useRef, useState } from 'react'

// Session CAST persistante (vit au niveau de l'App, pas du lecteur) : le WebSocket vers la
// TV reste ouvert même quand on quitte le lecteur → la diffusion ne s'arrête QUE sur
// « Arrêter » (stop()). Le lecteur pousse l'état de lecture via push(); au (re)pairing on
// renvoie le dernier état connu. Un F5 coupe la session (le WS vit dans la page).

export function useCastSession() {
  const [casting, setCasting] = useState(false)
  const [err, setErr] = useState('')
  const wsRef = useRef(null)
  const pingRef = useRef(null)
  const lastStateRef = useRef(null)

  const stop = useCallback(() => {
    clearInterval(pingRef.current)
    try { wsRef.current?.close() } catch { /* noop */ }
    wsRef.current = null
    setCasting(false)
  }, [])

  const push = useCallback((state) => {
    lastStateRef.current = state
    const ws = wsRef.current
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state }))
  }, [])

  const start = useCallback((code) => {
    const c = (code || '').trim().toUpperCase()
    if (c.length < 4) { setErr('Code à 4 caractères'); return }
    setErr('')
    const token = localStorage.getItem('token') || ''
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/cast/ws?role=phone&code=${encodeURIComponent(c)}&token=${encodeURIComponent(token)}`)
    wsRef.current = ws
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data) } catch { return }
      if (m.type === 'paired') { setCasting(true); setErr(''); if (lastStateRef.current) push(lastStateRef.current) }
      else if (m.type === 'error') { setErr(m.error === 'code' ? 'Code introuvable (la TV est-elle bien sur /tv ?)' : 'Connexion refusée'); try { ws.close() } catch { /* noop */ } }
      else if (m.type === 'tv_gone') { setErr('La TV s’est déconnectée'); stop() }
    }
    ws.onclose = () => { clearInterval(pingRef.current); if (wsRef.current === ws) { wsRef.current = null; setCasting(false) } }
    pingRef.current = setInterval(() => { try { ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })) } catch { /* noop */ } }, 25000)
  }, [push, stop])

  return { casting, err, setErr, start, stop, push }
}
