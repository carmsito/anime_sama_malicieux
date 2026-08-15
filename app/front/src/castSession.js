import { useCallback, useEffect, useRef, useState } from 'react'

// Session CAST persistante (vit au niveau de l'App, pas du lecteur) : le WebSocket vers la TV
// reste ouvert même quand on quitte le lecteur → la diffusion ne s'arrête QUE sur stop().
// RÉSILIENCE : si la socket tombe (app en arrière-plan, réseau), on se RECONNECTE tout seul
// au même code (la TV garde son salon) → fini les coupures involontaires. Le lecteur pousse
// l'état via push(); la TV peut renvoyer des commandes (ex. auto-scroll → page suivante) que
// l'on route vers onCmdRef (branché par le lecteur).

export function useCastSession() {
  const [casting, setCasting] = useState(false)
  const [err, setErr] = useState('')
  const wsRef = useRef(null)
  const pingRef = useRef(null)
  const reconnectRef = useRef(null)
  const codeRef = useRef('')          // dernier code (pour la reconnexion)
  const createRef = useRef(false)     // flux Presentation : le tel crée la salle (la TV rejoindra)
  const stoppedRef = useRef(true)     // true = arrêt volontaire → PAS de reconnexion
  const lastStateRef = useRef(null)
  const onCmdRef = useRef(null)       // le lecteur y branche son gestionnaire de commandes TV

  const connect = useCallback(() => {
    const c = codeRef.current
    if (!c) return
    clearTimeout(reconnectRef.current)
    const token = localStorage.getItem('token') || ''
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/cast/ws?role=phone&code=${encodeURIComponent(c)}&token=${encodeURIComponent(token)}${createRef.current ? '&create=1' : ''}`)
    wsRef.current = ws
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data) } catch { return }
      if (m.type === 'paired') {
        setCasting(true); setErr('')
        if (lastStateRef.current) { try { ws.send(JSON.stringify({ type: 'state', state: lastStateRef.current })) } catch { /* noop */ } }
      } else if (m.type === 'error') {
        // Salon introuvable / auth : inutile d'insister → on arrête proprement.
        setErr(m.error === 'code' ? 'Code introuvable (la TV est-elle bien sur /tv ?)' : 'Connexion refusée')
        stoppedRef.current = true; setCasting(false); try { ws.close() } catch { /* noop */ }
      } else if (m.type === 'cmd') {
        try { onCmdRef.current && onCmdRef.current(m.cmd) } catch { /* noop */ }
      }
    }
    ws.onclose = () => {
      clearInterval(pingRef.current)
      if (wsRef.current === ws) wsRef.current = null
      if (!stoppedRef.current) reconnectRef.current = setTimeout(connect, 1500)   // coupure inattendue → on retente
      else setCasting(false)
    }
    pingRef.current = setInterval(() => { try { ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })) } catch { /* noop */ } }, 25000)
  }, [])

  const start = useCallback((code, opts) => {
    const c = (code || '').trim().toUpperCase()
    if (c.length < 4) { setErr('Code à 4 caractères'); return }
    setErr(''); codeRef.current = c; createRef.current = !!(opts && opts.create); stoppedRef.current = false
    connect()
  }, [connect])

  const stop = useCallback(() => {
    stoppedRef.current = true
    clearInterval(pingRef.current); clearTimeout(reconnectRef.current)
    try { wsRef.current?.close() } catch { /* noop */ }
    wsRef.current = null; codeRef.current = ''; setCasting(false)
  }, [])

  const push = useCallback((state) => {
    lastStateRef.current = state
    const ws = wsRef.current
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state }))
  }, [])

  // Retour au premier plan : si la socket est tombée en arrière-plan, on se reconnecte vite.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && !stoppedRef.current &&
          (!wsRef.current || wsRef.current.readyState > 1)) { clearTimeout(reconnectRef.current); connect() }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [connect])

  return { casting, err, setErr, start, stop, push, onCmdRef }
}
