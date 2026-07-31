import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { gsap } from 'gsap'
import { api } from '../api/client'

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
  const imgRef = useRef()
  const num = Number(chapterNum)

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
      { opacity: 1, x: 0, duration: .18, ease: 'power2.out' }
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
    const k = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') goNext()
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') goPrev()
      if (e.key === 'Escape') navigate(`/manga/${mangaId}`)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [goNext, goPrev, navigate, mangaId])

  // Navigation au scroll (comme une liseuse) : bas = page suivante, haut = précédente.
  // Activée seulement si l'utilisateur a coché le mode (scrollNav).
  const wheelLock = useRef(0)
  const onWheel = useCallback((e) => {
    if (!scrollNav) return
    const now = Date.now()
    if (now - wheelLock.current < 350) return       // 1 cran = 1 page
    if (Math.abs(e.deltaY) < 12) return
    wheelLock.current = now
    if (e.deltaY > 0) goNext(); else goPrev()
  }, [scrollNav, goNext, goPrev])

  // Swipe vertical tactile (mobile) : glisser vers le haut = page suivante.
  const touchStartY = useRef(null)
  const onTouchStart = useCallback((e) => { touchStartY.current = e.touches[0].clientY }, [])
  const onTouchEnd = useCallback((e) => {
    if (!scrollNav || touchStartY.current == null) return
    const dy = e.changedTouches[0].clientY - touchStartY.current
    touchStartY.current = null
    if (Math.abs(dy) < 45) return                   // ignore les petits mouvements
    if (dy < 0) goNext(); else goPrev()             // doigt vers le haut → page suivante
  }, [scrollNav, goNext, goPrev])

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
        onTouchEnd={onTouchEnd}
        style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
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
            {/* Click zones */}
            <div onClick={goPrev} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '30%', cursor: 'pointer', zIndex: 10 }} />
            <div onClick={goNext} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '30%', cursor: 'pointer', zIndex: 10 }} />
            {!imgReady && <div className="spin" style={{ position: 'absolute' }} />}
            <img
              ref={imgRef}
              key={images[current]}
              src={images[current]}
              alt={`Page ${current + 1}`}
              onLoad={() => setImgReady(true)}
              style={{
                maxHeight: '100%', maxWidth: '100%',
                objectFit: 'contain', display: 'block',
                opacity: imgReady ? 1 : 0, transition: 'opacity .12s',
                userSelect: 'none',
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
