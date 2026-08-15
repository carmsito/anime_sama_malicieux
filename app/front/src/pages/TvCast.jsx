import React, { useEffect, useRef, useState } from 'react'

// Écran RÉCEPTEUR (à ouvrir sur la TV). Se connecte au relais Cast en rôle « tv », affiche
// un code, puis rend la page envoyée par le téléphone. Aucune auth requise : les images de
// chapitre sont servies publiquement, la TV les charge directement depuis l'état reçu.

const wsUrl = (params) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/cast/ws?${new URLSearchParams(params)}`

export default function TvCast() {
  const [code, setCode] = useState('')
  const [paired, setPaired] = useState(false)
  const [state, setState] = useState(null)   // { mangaId, chapterNum, page, ... }
  const wsRef = useRef(null)
  const retryRef = useRef(null)

  useEffect(() => {
    let closed = false
    const connect = () => {
      const ws = new WebSocket(wsUrl({ role: 'tv' }))
      wsRef.current = ws
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data) } catch { return }
        if (m.type === 'code') { setCode(m.code); setPaired(false); setState(null) }
        else if (m.type === 'paired') setPaired(true)
        else if (m.type === 'state') setState(m.state)
        else if (m.type === 'unpaired') { setPaired(false); setState(null) }
      }
      ws.onclose = () => {
        if (closed) return
        setCode(''); setPaired(false)
        retryRef.current = setTimeout(connect, 1500)   // le relais est peut-être en redéploiement
      }
    }
    connect()
    return () => { closed = true; clearTimeout(retryRef.current); try { wsRef.current?.close() } catch { /* noop */ } }
  }, [])

  const imgUrl = state
    ? `/api/mangas/${state.mangaId}/chapters/${state.chapterNum}/images/${state.page}`
    : null

  const wrap = { position: 'fixed', inset: 0, background: '#000', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit', overflow: 'hidden' }

  // Lecture en cours → page plein écran.
  if (imgUrl) {
    return (
      <div style={wrap}>
        <img key={imgUrl} src={imgUrl} alt=""
          style={{ maxWidth: '100vw', maxHeight: '100vh', objectFit: 'contain' }} />
      </div>
    )
  }

  // Écran d'accueil : code de diffusion.
  return (
    <div style={wrap}>
      <div style={{ textAlign: 'center', padding: '2rem' }}>
        <div style={{ fontSize: '1.4rem', fontWeight: 700, opacity: .8, marginBottom: '1.5rem' }}>
          {paired ? 'Connecté — en attente de lecture…' : 'Diffuser sur cette TV'}
        </div>
        {!paired && (
          <>
            <div style={{ fontSize: 'clamp(3rem, 14vw, 10rem)', fontWeight: 900, letterSpacing: '.15em',
              color: '#e50914', lineHeight: 1 }}>
              {code || '····'}
            </div>
            <div style={{ marginTop: '2rem', fontSize: '1.1rem', opacity: .55, maxWidth: 640, marginInline: 'auto' }}>
              Dans le lecteur, sur ton téléphone : bouton <b>Diffuser</b> → saisis ce code.
            </div>
          </>
        )}
        {paired && (
          <div style={{ fontSize: '1rem', opacity: .45 }}>Tourne les pages depuis ton téléphone.</div>
        )}
      </div>
    </div>
  )
}
