import React, { useEffect, useMemo, useRef, useState } from 'react'

// Écran RÉCEPTEUR (à ouvrir sur la TV). Se connecte au relais Cast en rôle « tv », affiche
// un code, puis rend ce que le téléphone pilote : soit la page entière (lecture normale),
// soit le Mode Cinéma (caméra qui cadre la case courante). Aucune auth : les images de
// chapitre sont servies publiquement.
//
// Le téléphone reste le maître du tempo : il envoie {page, cinema, panels, panelIdx, scale}.
// La TV rejoue exactement la même caméra que le lecteur (même formule de cadrage).

const wsUrl = (params) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/cast/ws?${new URLSearchParams(params)}`

const isWholePage = (ps) => !ps || !ps.length || (ps.length === 1 && ps[0].w >= 0.98 && ps[0].h >= 0.98)

// Confort de lecture : mêmes filtres CSS que le lecteur (sépia / nuit + luminosité).
const filterCss = (f, b100) => {
  const b = (b100 || 100) / 100
  if (f === 'sepia') return `sepia(.55) saturate(.9) brightness(${b})`
  if (f === 'night') return `sepia(.35) hue-rotate(-8deg) contrast(.95) brightness(${b * 0.9})`
  return b !== 1 ? `brightness(${b})` : 'none'
}

export default function TvCast() {
  const [code, setCode] = useState('')
  const [paired, setPaired] = useState(false)
  const [state, setState] = useState(null)   // { mangaId, chapterNum, page, cinema, panels, panelIdx, scale }
  const [dims, setDims] = useState(null)      // { natW, natH } de l'image courante
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [scrollY, setScrollY] = useState(0)   // défilement vertical (auto-scroll, mode normal)
  const wsRef = useRef(null)
  const retryRef = useRef(null)
  const scrollRef = useRef(0)
  const rafRef = useRef(0)

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
        retryRef.current = setTimeout(connect, 1500)   // relais peut-être en redéploiement
      }
    }
    connect()
    return () => { closed = true; clearTimeout(retryRef.current); try { wsRef.current?.close() } catch { /* noop */ } }
  }, [])

  useEffect(() => {
    const onR = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onR)
    window.addEventListener('orientationchange', onR)
    return () => { window.removeEventListener('resize', onR); window.removeEventListener('orientationchange', onR) }
  }, [])

  const imgUrl = state ? `/api/mangas/${state.mangaId}/chapters/${state.chapterNum}/images/${state.page}` : null
  // Nouvelle image → on oublie les dimensions + on remet le défilement en haut.
  useEffect(() => { setDims(null); scrollRef.current = 0; setScrollY(0) }, [imgUrl])

  // Paramètres live (vitesse / pause / zoom) lus sans redémarrer la machine à chaque push.
  const paramsRef = useRef({ speed: 1, pause: 0, zoom: 1 })
  paramsRef.current = { speed: state?.speed || 1, pause: state?.pause || 0, zoom: state?.normZoom || 1 }
  const pauseTimerRef = useRef(0)
  const sendCmd = (cmd) => { try { wsRef.current?.readyState === 1 && wsRef.current.send(JSON.stringify({ type: 'cmd', cmd })) } catch { /* noop */ } }

  // Auto-scroll (mode normal) : PAUSE haut (temps de pause du profil) → défilement vertical
  // (vitesse × zoom pilotés en direct) → PAUSE bas → demande la page suivante au téléphone.
  const autoscroll = state?.autoscroll && !(state?.cinema && !isWholePage(state?.panels))
  useEffect(() => {
    cancelAnimationFrame(rafRef.current); clearTimeout(pauseTimerRef.current)
    if (!autoscroll || !dims) return
    const CW = vp.w, CH = vp.h, dispH = CW * (dims.natH / dims.natW)
    const pauseMs = Math.max(0, paramsRef.current.pause) * 1000
    scrollRef.current = 0; setScrollY(0)
    let last = 0
    const tick = (now) => {
      if (!last) last = now
      const dt = Math.min(0.05, (now - last) / 1000); last = now
      const { speed, zoom } = paramsRef.current
      const maxS = Math.max(0, dispH * zoom - CH)
      scrollRef.current = Math.min(maxS, scrollRef.current + 45 * speed * dt)
      setScrollY(scrollRef.current)
      if (scrollRef.current < maxS - 0.5) rafRef.current = requestAnimationFrame(tick)
      else pauseTimerRef.current = setTimeout(() => sendCmd('next'), pauseMs)   // bas → pause → page suivante
    }
    const initMax = Math.max(0, dispH * paramsRef.current.zoom - CH)
    if (initMax <= 0) { pauseTimerRef.current = setTimeout(() => sendCmd('next'), pauseMs + 1400); return () => clearTimeout(pauseTimerRef.current) }
    pauseTimerRef.current = setTimeout(() => { last = 0; rafRef.current = requestAnimationFrame(tick) }, pauseMs)  // pause haut → défile
    return () => { cancelAnimationFrame(rafRef.current); clearTimeout(pauseTimerRef.current) }
  }, [autoscroll, dims, vp, imgUrl]) // eslint-disable-line

  // Transform caméra : miroir EXACT du lecteur (EpubReader). L'image est dimensionnée à la
  // largeur du viewport (dispW = CW) puis on cadre soit la case, soit la planche entière.
  const cam = useMemo(() => {
    if (!dims) return null
    const CW = vp.w, CH = vp.h
    const dispW = CW, dispH = CW * (dims.natH / dims.natW)
    const panels = state?.panels
    const cinema = state?.cinema && !isWholePage(panels)
    if (cinema) {
      const p = panels[Math.min(state.panelIdx || 0, panels.length - 1)] || { x: 0, y: 0, w: 1, h: 1 }
      const pw = p.w * dispW, ph = p.h * dispH
      const cx = (p.x + p.w / 2) * dispW, cy = (p.y + p.h / 2) * dispH
      const baseK = Math.min((CW / pw) * 0.96, (CH / ph) * 0.96)
      const k = baseK * ((state.scale || 100) / 100)
      return { dispW, dispH, transform: `translate(${CW / 2 - k * cx}px, ${CH / 2 - k * cy}px) scale(${k})` }
    }
    // Auto-scroll : pleine largeur × zoom, centré, translaté verticalement (auto) + « souris » :
    // panX = déplacement horizontal (voir les côtés en zoom), panY = nudge vertical manuel.
    if (autoscroll) {
      const k = (CW / dispW) * (state?.normZoom || 1)
      const x = (CW - dispW * k) / 2 - (state?.panX || 0) * dispW * k
      const yNudge = (state?.panY || 0) * CH * 2
      return { dispW, dispH, transform: `translate(${x}px, ${-(scrollY + yNudge)}px) scale(${k})`, smooth: false }
    }
    // Lecture normale : contain, + zoom/pan « souris » piloté depuis la télécommande.
    const z = state?.normZoom || 1
    const k = Math.min(1, CW / dispW, CH / dispH) * z
    const focusX = (0.5 + (state?.panX || 0)) * dispW
    const focusY = (0.5 + (state?.panY || 0)) * dispH
    return { dispW, dispH, transform: `translate(${CW / 2 - k * focusX}px, ${CH / 2 - k * focusY}px) scale(${k})` }
  }, [dims, vp, state, autoscroll, scrollY])

  const wrap = { position: 'fixed', inset: 0, background: '#000', color: '#fff', overflow: 'hidden',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit' }

  if (imgUrl) {
    return (
      <div style={wrap}>
        <img key={imgUrl} src={imgUrl} alt=""
          onLoad={(e) => setDims({ natW: e.target.naturalWidth, natH: e.target.naturalHeight })}
          style={cam
            ? { position: 'absolute', left: 0, top: 0, width: cam.dispW, height: cam.dispH,
                transformOrigin: '0 0', transform: cam.transform,
                transition: cam.smooth === false ? 'none' : 'transform .4s cubic-bezier(.4,0,.2,1)',
                willChange: 'transform', filter: filterCss(state?.filter, state?.brightness) }
            : { maxWidth: '100vw', maxHeight: '100vh', objectFit: 'contain', opacity: 0 }} />
      </div>
    )
  }

  return (
    <div style={wrap}>
      <div style={{ textAlign: 'center', padding: '2rem' }}>
        <div style={{ fontSize: '1.4rem', fontWeight: 700, opacity: .8, marginBottom: '1.5rem' }}>
          {paired ? 'Connecté — en attente de lecture…' : 'Diffuser sur cette TV'}
        </div>
        {!paired && (
          <>
            <div style={{ fontSize: 'clamp(3rem, 14vw, 10rem)', fontWeight: 900, letterSpacing: '.15em', color: '#e50914', lineHeight: 1 }}>
              {code || '····'}
            </div>
            {code && (
              <div style={{ marginTop: '1.8rem', display: 'inline-block', background: '#fff', padding: 14, borderRadius: 16 }}>
                <img alt="QR de diffusion" width={220} height={220} style={{ display: 'block', width: 220, height: 220 }}
                  src={`/api/cast/qr?data=${encodeURIComponent(`${location.origin}/?castcode=${code}`)}`} />
              </div>
            )}
            <div style={{ marginTop: '1.6rem', fontSize: '1.1rem', opacity: .6, maxWidth: 640, marginInline: 'auto' }}>
              📷 <b>Scanne ce QR</b> avec l’appareil photo de ton téléphone — l’app s’ouvre et lance la diffusion.
            </div>
            <div style={{ marginTop: '.6rem', fontSize: '.95rem', opacity: .4, maxWidth: 640, marginInline: 'auto' }}>
              Ou dans le lecteur : bouton <b>Diffuser</b> → saisis le code.
            </div>
          </>
        )}
        {paired && <div style={{ fontSize: '1rem', opacity: .45 }}>Pilote depuis ton téléphone.</div>}
      </div>
    </div>
  )
}
