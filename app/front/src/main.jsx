import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
)

// Enregistre le service worker (PWA installable sur mobile) et FORCE sa mise à jour :
// sans ça, un ancien SW « cache d'abord » restait coincé et servait de vieux fichiers.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller  // un SW pilotait-il déjà ?
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => { reg.update() })   // vérifie tout de suite s'il existe un nouveau SW
      .catch(() => {})
  })
  // Quand un NOUVEAU service worker prend le contrôle (vraie MAJ, pas 1er install) → on
  // recharge une fois pour repartir sur du frais au lieu de rester sur l'ancien SW.
  let swReloaded = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swReloaded || !hadController) return
    swReloaded = true
    window.location.reload()
  })
}
