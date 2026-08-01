import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { gsap } from 'gsap'
import { api } from '../api/client'

const IS_TOUCH = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches
const ZOOM_LEVEL = 2.5

export default function EpubReader() {
  const { mangaId, chapterNum } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [manga, setManga] = useState(null)
  const [images, setImages] = useState([])
  const [current, setCurrent] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [imgReady, setImgReady] = useState(false)
  // Préférence de navigation au scroll (molette/swipe) — désactivée par défaut, persistée
  const [scrollNav, setScrollNav] = useState(() => localStorage.getItem('reader_scrollnav') === '1')
  const [fullscreen, setFullscreen] = useState(false)
  // Zoom géré par l'app (pas le navigateur) : double-tap pour zoomer, glisser pour naviguer.
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [origin, setOrigin] = useState({ x: 0, y: 0 })
  const zoomed = zoom > 1
  const imgRef = useRef()
  const num = Number(chapterNum)
  const lastTapRef = useRef({ t: 0, x: 0, y: 0 })
  const panStartRef = useRef(null)
  const touchStartRef = useRef({ x: 0, y: 0 })
  const touchMovedRef = useRef(false)

  // Réinitialise le zoom à chaque changement de page / chapitre
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [current, chapterNum])

  const toggleZoomAt = (clientX, clientY) => {
    if (zoomed) { setZoom(1); setPan({ x: 0, y: 0 }); return }
    const img = imgRef.current
    if (!img) return
    const r = img.getBoundingClientRect()
    setOrigin({ x: clientX - r.left, y: clientY - r.top })
    setPan({ x: 0, y: 0 })
    setZoom(ZOOM_LEVEL)
  }

  const toggleScrollNav = () => {
    setScrollNav((v) => { localStorage.setItem('reader_scrollnav', v ? '0' : '1'); return !v })
  }
  // Page forcée via l'URL (?p=N) : "Lire depuis le début" (p=0) ou reprise ciblée.
  // Si présent, on NE reprend PAS la page enregistrée.
  const forcedPage = searchParams.get('p')

  useEffect(() => { api.getManga(mangaId).then(setManga).catch(console.error) }, [mangaId])

  useEffect(() => {
    setLoaded(false); setCurrent(0); setImgReady(false)
    fetch(`/api/mangas/${mangaId}/chapters/${chapterNum}/images`)
      .then((r) => r.json())
      .then((d) => {
        const urls = d.urls || []
        setImages(urls)
        setLoaded(true)
        if (forcedPage != null) {
          // page imposée par l'URL (bornée) — pas de reprise auto.
          // 'last' = dernière page (arrivée sur le chapitre précédent).
          const p = forcedPage === 'last'
            ? urls.length - 1
            : Math.max(0, Math.min(Number(forcedPage) || 0, urls.length - 1))
          setCurrent(Math.max(0, p))
          return
        }
        // Reprise : positionne sur la dernière page lue de ce chapitre
        api.getProgress(mangaId).then((res) => {
          const p = (res.progress || []).find((x) => Number(x.chapter_number) === num)
          if (p && p.page > 0 && p.page < urls.length) setCurrent(p.page)
        }).catch(() => {})
      })
      .catch(console.error)
  }, [mangaId, chapterNum, forcedPage]) // eslint-disable-line

  // Sauvegarde de la progression (marque-page), throttlée
  useEffect(() => {
    if (!loaded || images.length === 0) return
    const t = setTimeout(() => {
      api.saveProgress(mangaId, num, current, images.length).catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [current, loaded, images.length, mangaId, num])

  const slide = useCallback((dir) => {
    if (!imgRef.current) return
    gsap.fromTo(imgRef.current,
      { opacity: 0, x: dir === 1 ? -20 : 20 },
      {
        opacity: 1, x: 0, duration: .18, ease: 'power2.out',
        // Retire la transform après l'anim : évite que l'image reste sur une couche
        // GPU rendue en 1x (flou sur les liseuses e-ink / écrans haute densité).
        clearProps: 'transform',
      }
    )
  }, [])

  // Chapitres triés → chapitre précédent / suivant (gère les numéros non consécutifs)
  const sortedNums = (manga?.chapters || []).map((c) => c.number).sort((a, b) => a - b)
  const nextChapNum = sortedNums.find((n) => n > num)
  const prevChapNum = [...sortedNums].reverse().find((n) => n < num)

  const goNext = useCallback(() => {
    if (current < images.length - 1) { setCurrent((p) => p + 1); setImgReady(false); slide(1); return }
    // fin du chapitre → chapitre suivant, 1ʳᵉ planche
    if (nextChapNum != null) navigate(`/manga/${mangaId}/read/${nextChapNum}?p=0`)
  }, [current, images.length, slide, nextChapNum, mangaId, navigate])

  const goPrev = useCallback(() => {
    if (current > 0) { setCurrent((p) => p - 1); setImgReady(false); slide(-1); return }
    // début du chapitre → chapitre précédent, dernière planche
    if (prevChapNum != null) navigate(`/manga/${mangaId}/read/${prevChapNum}?p=last`)
  }, [current, slide, prevChapNum, mangaId, navigate])

  useEffect(() => {
    // Liseuses (Boox, etc.) : les boutons latéraux envoient des touches clavier
    // (PageDown/PageUp, Volume Bas/Haut, flèches, Espace). Bas = suivant, Haut = précédent.
    // Toujours actif (indépendant du toggle scroll molette).
    const NEXT = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar', 'AudioVolumeDown'])
    const PREV = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'AudioVolumeUp'])
    const NEXT_CODES = new Set([34, 32, 174])  // PageDown, Space, VolumeDown
    const PREV_CODES = new Set([33, 175])      // PageUp, VolumeUp
    const k = (e) => {
      if (NEXT.has(e.key) || NEXT_CODES.has(e.keyCode)) { e.preventDefault(); goNext() }
      else if (PREV.has(e.key) || PREV_CODES.has(e.keyCode)) { e.preventDefault(); goPrev() }
      else if (e.key === 'Escape') navigate(`/manga/${mangaId}`)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [goNext, goPrev, navigate, mangaId])

  // Navigation à la molette (liseuse/PC) : bas = suivant, haut = précédent. Sous toggle.
  const wheelLock = useRef(0)
  const onWheel = useCallback((e) => {
    if (!scrollNav || zoomed) return
    const now = Date.now()
    if (now - wheelLock.current < 350) return       // 1 cran = 1 page
    if (Math.abs(e.deltaY) < 12) return
    wheelLock.current = now
    if (e.deltaY > 0) goNext(); else goPrev()
  }, [scrollNav, zoomed, goNext, goPrev])

  // ── Gestes tactiles : tap latéral = page, double-tap = zoom, glisser = pan/swipe ──
  const onTouchStart = useCallback((e) => {
    const t = e.touches[0]
    touchStartRef.current = { x: t.clientX, y: t.clientY }
    touchMovedRef.current = false
    if (zoomed) panStartRef.current = { px: pan.x, py: pan.y, tx: t.clientX, ty: t.clientY }
  }, [zoomed, pan])

  const onTouchMove = useCallback((e) => {
    if (zoomed && panStartRef.current) {
      const t = e.touches[0]
      const dx = t.clientX - panStartRef.current.tx
      const dy = t.clientY - panStartRef.current.ty
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) touchMovedRef.current = true
      setPan({ x: panStartRef.current.px + dx, y: panStartRef.current.py + dy })
    }
  }, [zoomed])

  const onTouchEnd = useCallback((e) => {
    const t = e.changedTouches[0]
    const now = Date.now()
    // Fin d'un glissement pour paner (zoomé) → ne pas interpréter comme un tap
    if (zoomed && touchMovedRef.current) { panStartRef.current = null; return }
    const dx = t.clientX - touchStartRef.current.x
    const dy = t.clientY - touchStartRef.current.y
    const moved = Math.abs(dx) > 12 || Math.abs(dy) > 12
    const r = e.currentTarget.getBoundingClientRect()

    // Swipe vertical (mode molette/scroll activé, non zoomé)
    if (!zoomed && scrollNav && Math.abs(dy) >= 45 && Math.abs(dy) > Math.abs(dx)) {
      if (dy < 0) goNext(); else goPrev()
      return
    }
    if (moved) return  // glissement non géré → rien

    // ── C'est un TAP ──
    const last = lastTapRef.current
    const isDouble = (now - last.t < 300) && Math.abs(t.clientX - last.x) < 45 && Math.abs(t.clientY - last.y) < 45
    if (zoomed) {
      // double-tap n'importe où → dézoome
      if (isDouble) { lastTapRef.current = { t: 0, x: 0, y: 0 }; setZoom(1); setPan({ x: 0, y: 0 }) }
      else lastTapRef.current = { t: now, x: t.clientX, y: t.clientY }
      return
    }
    const x = t.clientX - r.left
    if (x < r.width * 0.33) { goPrev(); return }     // tiers gauche → précédent
    if (x > r.width * 0.67) { goNext(); return }     // tiers droit → suivant
    // Tiers central : double-tap → zoome
    if (isDouble) { lastTapRef.current = { t: 0, x: 0, y: 0 }; toggleZoomAt(t.clientX, t.clientY) }
    else lastTapRef.current = { t: now, x: t.clientX, y: t.clientY }
  }, [zoomed, scrollNav, goNext, goPrev, pan]) // eslint-disable-line

  // Souris (desktop) : clic latéral = page, double-clic = zoom
  const onAreaClick = useCallback((e) => {
    if (IS_TOUCH || zoomed) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    if (x < r.width * 0.33) goPrev()
    else if (x > r.width * 0.67) goNext()
  }, [zoomed, goPrev, goNext])
  const onAreaDblClick = useCallback((e) => {
    if (IS_TOUCH) return
    toggleZoomAt(e.clientX, e.clientY)
  }, [zoomed]) // eslint-disable-line

  const prevChap = prevChapNum != null ? { number: prevChapNum } : null
  const nextChap = nextChapNum != null ? { number: nextChapNum } : null

  return (
    <div className="reader-root" style={{ display: 'flex', flexDirection: 'column', background: '#000' }}>
      {/* Top bar */}
      <div className="reader-topbar" style={{
        flexShrink: 0, height: 48,
        display: fullscreen ? 'none' : 'flex', alignItems: 'center', padding: '0 1rem', gap: '.6rem',
        background: 'rgba(0,0,0,.9)', borderBottom: '1px solid rgba(255,255,255,.08)',
      }}>
        <button
          onClick={() => navigate(`/manga/${mangaId}`)}
          style={{ color: '#fff', fontSize: '1.1rem', padding: '.2rem .4rem', background: 'none', border: 'none', cursor: 'pointer' }}
        >←</button>
        <span style={{ color: 'rgba(255,255,255,.5)', fontSize: '.82rem' }}>
          {manga?.name} — Chap. {chapterNum}
        </span>
        <div style={{ flex: 1 }} />
        {loaded && images.length > 0 && current > 0 && (
          <button onClick={() => { setCurrent(0); setImgReady(false); slide(-1) }}
            title="Reprendre depuis le début"
            style={{ color: 'rgba(255,255,255,.6)', fontSize: '.78rem', padding: '.25rem .55rem',
              background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '.3rem' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
            Début
          </button>
        )}
        <button onClick={toggleScrollNav}
          title={scrollNav ? 'Navigation au scroll : ON' : 'Navigation au scroll : OFF'}
          style={{ color: scrollNav ? '#e50914' : 'rgba(255,255,255,.6)', padding: '.28rem .42rem',
            background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4, cursor: 'pointer',
            display: 'flex', alignItems: 'center' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="6" y="2" width="12" height="20" rx="6"/><line x1="12" y1="6" x2="12" y2="10"/>
          </svg>
        </button>
        <button onClick={() => setFullscreen(true)} title="Plein écran"
          style={{ color: 'rgba(255,255,255,.6)', padding: '.28rem .42rem',
            background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4, cursor: 'pointer',
            display: 'flex', alignItems: 'center' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>
          </svg>
        </button>
        <span style={{ color: 'rgba(255,255,255,.35)', fontSize: '.78rem' }}>
          {loaded ? `${current + 1} / ${images.length}` : '…'}
        </span>
        <div style={{ display: 'flex', gap: '.3rem' }}>
          {prevChap && (
            <button onClick={() => navigate(`/manga/${mangaId}/read/${prevChap.number}`)}
              style={{ color: 'rgba(255,255,255,.6)', fontSize: '.8rem', padding: '.25rem .5rem',
                background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
              ‹ {prevChap.number}
            </button>
          )}
          {nextChap && (
            <button onClick={() => navigate(`/manga/${mangaId}/read/${nextChap.number}`)}
              style={{ color: 'rgba(255,255,255,.6)', fontSize: '.8rem', padding: '.25rem .5rem',
                background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
              {nextChap.number} ›
            </button>
          )}
        </div>
      </div>

      {/* Image area */}
      <div
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={onAreaClick}
        onDoubleClick={onAreaDblClick}
        style={{
          flex: 1, overflow: 'hidden', position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          touchAction: 'none',   // on gère nous-mêmes zoom/scroll (pas le navigateur)
          background: '#000',    // fond opaque → repaint propre en pannant (pas de traînée)
        }}
      >
        {!loaded && (
          <div style={{ color: 'rgba(255,255,255,.3)', fontSize: '.88rem', display: 'flex', gap: '.5rem', alignItems: 'center' }}>
            <div className="spin" /> Chargement…
          </div>
        )}
        {loaded && images.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,.3)' }}>Aucune image trouvée</div>
        )}
        {loaded && images.length > 0 && (
          <>
            {!imgReady && <div className="spin" style={{ position: 'absolute' }} />}
            <img
              ref={imgRef}
              key={images[current]}
              src={images[current]}
              alt={`Page ${current + 1}`}
              onLoad={() => setImgReady(true)}
              draggable={false}
              style={{
                maxHeight: '100%', maxWidth: '100%',
                objectFit: 'contain', display: 'block',
                opacity: imgReady ? 1 : 0,
                userSelect: 'none', cursor: zoomed ? 'grab' : 'default',
                ...(zoomed
                  ? {
                    // translate3d + will-change + backface → couche GPU propre (pas de traînée)
                    transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                    transformOrigin: `${origin.x}px ${origin.y}px`,
                    transition: 'none',
                    willChange: 'transform',
                    backfaceVisibility: 'hidden',
                    WebkitBackfaceVisibility: 'hidden',
                  }
                  : { transition: 'opacity .12s' }),
              }}
            />
          </>
        )}
      </div>

      {/* Bouton flottant pour quitter le plein écran */}
      {fullscreen && (
        <button onClick={() => setFullscreen(false)} className="reader-fs-exit" title="Quitter le plein écran">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>
          </svg>
        </button>
      )}

      {/* Bottom bar */}
      <div className="reader-bottombar" style={{
        flexShrink: 0, height: 44,
        display: fullscreen ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', gap: '1.5rem',
        background: 'rgba(0,0,0,.9)', borderTop: '1px solid rgba(255,255,255,.08)',
      }}>
        <button onClick={goPrev} disabled={current === 0}
          style={{ color: current === 0 ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.7)',
            background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4,
            padding: '.3rem .7rem', cursor: 'pointer', fontSize: '1rem' }}>←</button>
        <span style={{ color: 'rgba(255,255,255,.45)', fontSize: '.8rem', minWidth: 60, textAlign: 'center' }}>
          {loaded ? `${current + 1} / ${images.length}` : '…'}
        </span>
        <button onClick={goNext} disabled={current >= images.length - 1}
          style={{ color: current >= images.length - 1 ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.7)',
            background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4,
            padding: '.3rem .7rem', cursor: 'pointer', fontSize: '1rem' }}>→</button>
      </div>
    </div>
  )
}
