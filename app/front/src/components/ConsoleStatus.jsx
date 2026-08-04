import React, { useContext } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ConsoleCtx } from '../contexts'

// Toast (façon JobStatus) affiché quand une session console tourne ET qu'on est
// ailleurs dans le site → rappelle qu'elle est vivante + bouton pour y revenir.
export default function ConsoleStatus() {
  const { phase, close } = useContext(ConsoleCtx)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  if (phase !== 'open') return null
  if (pathname === '/admin/console') return null

  return (
    <div className="console-toast">
      <div className="ct-head">
        <div className="ct-dot" />
        <div className="ct-name">Console active</div>
        <button className="jt-x" title="Fermer la session" onClick={close}>✕</button>
      </div>
      <div className="ct-txt">Session shell ouverte — les commandes en cours continuent.</div>
      <button className="btn btn-primary btn-sm ct-btn" onClick={() => navigate('/admin/console')}>
        Revenir à la console
      </button>
    </div>
  )
}
