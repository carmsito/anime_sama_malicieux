import React, { useEffect, useRef, useState, useContext } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { AuthCtx, ConsoleCtx } from '../contexts'

// Console admin : terminal web relié par WebSocket à un shell ROOT sur l'hôte.
// La SESSION vit au niveau de l'App (ConsoleCtx) : quitter cette page ne la coupe
// plus — un toast propose de revenir tant qu'elle est ouverte.
export default function Console() {
  const { user } = useContext(AuthCtx)
  const { phase, errMsg, hostEl, parkHost, fit, focus, connect, close } = useContext(ConsoleCtx)
  const navigate = useNavigate()
  const [status, setStatus] = useState(null)   // {ready, reason, target}
  const [passphrase, setPassphrase] = useState('')
  const boxRef = useRef(null)

  useEffect(() => {
    if (user && user.role !== 'admin') { navigate('/'); return }
    api.consoleStatus().then(setStatus).catch((e) => setStatus({ ready: false, reason: e.message }))
  }, [user]) // eslint-disable-line

  // Ré-attache le terminal persistant dans la page ; au démontage on le "gare"
  // dans le holder caché (la session continue de tourner).
  useEffect(() => {
    const box = boxRef.current
    const host = hostEl()
    if (!box || !host) return undefined
    box.appendChild(host)
    fit()
    focus()
    return () => { parkHost() }
  }, [phase, hostEl, parkHost, fit, focus])

  const live = phase === 'open' || phase === 'connecting' || phase === 'closed' || phase === 'error'

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

      {status && !status.ready && phase === 'idle' && (
        <div className="console-notready">
          <b>Console non disponible :</b> {status.reason}
          <div className="console-hint">
            Pour l'activer côté serveur (<code>.env</code>) : <code>CONSOLE_ENABLED=1</code>,
            <code>CONSOLE_PASSPHRASE=…</code>, <code>CONSOLE_SSH_TARGET=root@62.238.63.117</code>,
            clé <code>data/console_host_key</code> autorisée sur l'hôte.
          </div>
        </div>
      )}

      {status && status.ready && phase === 'idle' && (
        <div className="console-connect">
          <input
            type="password" placeholder="Passphrase console" value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && connect(passphrase)}
          />
          <button className="btn btn-primary btn-sm" onClick={() => connect(passphrase)}>Connecter</button>
          <span className="console-target">cible : {status.target}</span>
        </div>
      )}

      {errMsg && <div className="err-msg" style={{ margin: '.75rem 0' }}>{errMsg}</div>}
      {phase === 'connecting' && <div className="console-hint">Connexion…</div>}

      {live && (
        <>
          <div ref={boxRef} className="console-term" />
          <div className="console-actions">
            {phase === 'open' && (
              <span className="console-live">● session active — elle reste ouverte si tu navigues ailleurs</span>
            )}
            <button className="btn btn-ghost btn-sm" onClick={close}>
              {phase === 'open' ? 'Fermer la session' : 'Réinitialiser'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
