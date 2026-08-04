import React, { useEffect, useRef, useState, useContext } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { AuthCtx } from '../contexts'

// Console admin : terminal web (xterm chargé en LAZY → n'alourdit pas le bundle principal)
// relié par WebSocket à un shell ROOT sur l'hôte. Réservé admin + passphrase dédiée.
export default function Console() {
  const { user } = useContext(AuthCtx)
  const navigate = useNavigate()
  const [status, setStatus] = useState(null)   // {ready, reason, target}
  const [passphrase, setPassphrase] = useState('')
  const [phase, setPhase] = useState('idle')    // idle | connecting | open | closed | error
  const [errMsg, setErrMsg] = useState('')
  const termElRef = useRef(null)
  const termRef = useRef(null)
  const wsRef = useRef(null)
  const fitRef = useRef(null)

  useEffect(() => {
    if (user && user.role !== 'admin') { navigate('/'); return }
    api.consoleStatus().then(setStatus).catch((e) => setStatus({ ready: false, reason: e.message }))
  }, [user]) // eslint-disable-line

  const cleanup = () => {
    try { wsRef.current?.close() } catch { /* noop */ }
    try { termRef.current?.dispose() } catch { /* noop */ }
    wsRef.current = null; termRef.current = null; fitRef.current = null
  }
  useEffect(() => () => cleanup(), [])

  const connect = async () => {
    if (!passphrase) { setErrMsg('Entre la passphrase de la console.'); return }
    setErrMsg(''); setPhase('connecting')
    // Lazy-load xterm + son CSS uniquement maintenant
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ])
    await import('@xterm/xterm/css/xterm.css')

    const term = new Terminal({
      cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      theme: { background: '#0b0b0f', foreground: '#e6e6e6' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(termElRef.current)
    fit.fit()
    termRef.current = term; fitRef.current = fit

    const token = localStorage.getItem('token')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/admin/console/ws?token=${encodeURIComponent(token)}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const sendResize = () => {
      try {
        fit.fit()
        ws.readyState === 1 && ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      } catch { /* noop */ }
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', passphrase }))
      term.onData((d) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'data', data: d })))
      window.addEventListener('resize', sendResize)
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data)
          if (m.type === 'error') { setErrMsg(m.message); setPhase('error'); ws.close() }
          else if (m.type === 'ready') { setPhase('open'); setTimeout(sendResize, 50); term.focus() }
        } catch { /* ignore */ }
      } else {
        term.write(new Uint8Array(ev.data))
      }
    }
    ws.onclose = () => {
      window.removeEventListener('resize', sendResize)
      setPhase((p) => (p === 'error' ? p : 'closed'))
      try { term.write('\r\n\x1b[31m— session terminée —\x1b[0m\r\n') } catch { /* noop */ }
    }
    ws.onerror = () => { setErrMsg('Erreur de connexion WebSocket.'); setPhase('error') }
  }

  const disconnect = () => { cleanup(); setPhase('closed') }

  return (
    <div className="page console-page">
      <div className="users-head">
        <button className="detail-back" onClick={() => navigate('/admin/users')}>←</button>
        <h1>Console</h1>
      </div>

      <div className="console-warn">
        ⚠️ Shell <b>root sur l'hôte</b> (accès total). Réservé admin + passphrase. Toutes les
        commandes sont journalisées (audit). À utiliser en connaissance de cause.
      </div>

      {status && !status.ready && (
        <div className="console-notready">
          <b>Console non disponible :</b> {status.reason}
          <div className="console-hint">
            Pour l'activer côté serveur (<code>.env</code>) : <code>CONSOLE_ENABLED=1</code>,
            <code>CONSOLE_PASSPHRASE=…</code>, <code>CONSOLE_SSH_TARGET=root@62.238.63.117</code>,
            clé <code>data/console_host_key</code> autorisée sur l'hôte.
          </div>
        </div>
      )}

      {status && status.ready && phase !== 'open' && phase !== 'connecting' && (
        <div className="console-connect">
          <input
            type="password" placeholder="Passphrase console" value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && connect()}
          />
          <button className="btn btn-primary btn-sm" onClick={connect}>Connecter</button>
          <span className="console-target">cible : {status.target}</span>
        </div>
      )}

      {errMsg && <div className="err-msg" style={{ margin: '.75rem 0' }}>{errMsg}</div>}
      {phase === 'connecting' && <div className="console-hint">Connexion…</div>}

      {(phase === 'open' || phase === 'closed' || phase === 'connecting') && (
        <>
          <div ref={termElRef} className="console-term" />
          {phase === 'open' && (
            <button className="btn btn-ghost btn-sm" style={{ marginTop: '.6rem' }} onClick={disconnect}>
              Fermer la session
            </button>
          )}
        </>
      )}
    </div>
  )
}
