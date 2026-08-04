import { useCallback, useRef, useState } from 'react'

// Session console PERSISTANTE (vit au niveau de l'App, pas de la page).
//
// Le terminal xterm est monté UNE fois dans un div "hôte" créé hors de l'arbre React.
// Quand on quitte la page console, ce div est simplement RE-PARENTÉ dans un holder
// caché (au lieu d'être détruit) : le WebSocket reste ouvert, le PTY côté serveur
// n'est pas tué, et les commandes en cours continuent de tourner. Au retour sur la
// page, on le ré-attache dans le conteneur visible.
//
// Limite : un rechargement complet de l'onglet (F5) coupe forcément la session
// (le WebSocket vit dans la mémoire de la page).

const HOLDER_ID = 'console-host-holder'

function getHolder() {
  let h = document.getElementById(HOLDER_ID)
  if (!h) {
    h = document.createElement('div')
    h.id = HOLDER_ID
    // hors écran mais MESURABLE : xterm a besoin de dimensions réelles pour son fit
    h.style.cssText = 'position:fixed;left:-99999px;top:0;width:900px;height:500px;pointer-events:none;'
    document.body.appendChild(h)
  }
  return h
}

export function useConsoleSession() {
  const [phase, setPhase] = useState('idle')   // idle | connecting | open | closed | error
  const [errMsg, setErrMsg] = useState('')
  const hostRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const wsRef = useRef(null)
  const resizeHandlerRef = useRef(null)

  const hostEl = useCallback(() => hostRef.current, [])

  const fit = useCallback(() => {
    try {
      fitRef.current?.fit()
      const ws = wsRef.current
      const t = termRef.current
      if (ws && ws.readyState === 1 && t) {
        ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }))
      }
    } catch { /* noop */ }
  }, [])

  // Remet l'hôte dans le holder caché (quand on quitte la page) → session préservée.
  const parkHost = useCallback(() => {
    const h = hostRef.current
    if (h) { try { getHolder().appendChild(h) } catch { /* noop */ } }
  }, [])

  const close = useCallback(() => {
    if (resizeHandlerRef.current) {
      window.removeEventListener('resize', resizeHandlerRef.current)
      resizeHandlerRef.current = null
    }
    try { wsRef.current?.close() } catch { /* noop */ }
    wsRef.current = null
    try { termRef.current?.dispose() } catch { /* noop */ }
    termRef.current = null
    fitRef.current = null
    const h = hostRef.current
    if (h && h.parentNode) { try { h.parentNode.removeChild(h) } catch { /* noop */ } }
    hostRef.current = null
    setPhase('idle')
    setErrMsg('')
  }, [])

  const connect = useCallback(async (passphrase) => {
    if (!passphrase) { setErrMsg('Entre la passphrase de la console.'); return }
    setErrMsg('')
    setPhase('connecting')

    // xterm chargé en LAZY (chunk séparé) → n'alourdit pas le bundle principal
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ])
    await import('@xterm/xterm/css/xterm.css')

    const host = document.createElement('div')
    host.className = 'console-host'
    getHolder().appendChild(host)      // dans le DOM dès le départ → xterm peut mesurer
    hostRef.current = host

    const term = new Terminal({
      cursorBlink: true, fontSize: 13, scrollback: 5000,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      theme: { background: '#0b0b0f', foreground: '#e6e6e6' },
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(host)
    try { fitAddon.fit() } catch { /* noop */ }
    termRef.current = term
    fitRef.current = fitAddon

    const token = localStorage.getItem('token')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(
      `${proto}://${location.host}/api/admin/console/ws?token=${encodeURIComponent(token)}`
    )
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const onResize = () => fit()
    resizeHandlerRef.current = onResize

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', passphrase }))
      term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: d })) })
      window.addEventListener('resize', onResize)
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data)
          if (m.type === 'error') { setErrMsg(m.message); setPhase('error'); ws.close() }
          else if (m.type === 'ready') { setPhase('open'); setTimeout(fit, 50) }
        } catch { /* ignore */ }
      } else {
        term.write(new Uint8Array(ev.data))
      }
    }
    ws.onclose = () => {
      window.removeEventListener('resize', onResize)
      resizeHandlerRef.current = null
      setPhase((p) => (p === 'error' ? p : 'closed'))
      try { term.write('\r\n\x1b[31m— session terminée —\x1b[0m\r\n') } catch { /* noop */ }
    }
    ws.onerror = () => { setErrMsg('Erreur de connexion WebSocket.'); setPhase('error') }
  }, [fit])

  const focus = useCallback(() => { try { termRef.current?.focus() } catch { /* noop */ } }, [])

  return { phase, errMsg, hostEl, parkHost, fit, focus, connect, close }
}
