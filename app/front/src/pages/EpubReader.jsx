import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useContext } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { gsap } from 'gsap'
import { api } from '../api/client'
import { AuthCtx } from '../contexts'

const IS_TOUCH = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches
const ZOOM_LEVEL = 2.5
const DEFAULT_SENS = 1        // sensibilité de déplacement en zoom par défaut (= vitesse actuelle)

export default function EpubReader() {
  const { mangaId, chapterNum } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { user } = useContext(AuthCtx)
  // Préférences du lecteur stockées PAR UTILISATEUR (jamais global) → clés préfixées par l'id.
  const uid = user?.id || 'anon'
  const prefKey = (k) => `reader_${k}_${uid}`
  const [manga, setManga] = useState(null)
  const [images, setImages] = useState([])
  const [current, setCurrent] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [imgReady, setImgReady] = useState(false)
  // Préférences (par utilisateur) : chargées depuis localStorage selon l'uid (effet plus bas)
  const [scrollNav, setScrollNav] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [pageFlip, setPageFlip] = useState(false)
  const [fitWidth, setFitWidth] = useState(false)       // mode lecture défilement (fit largeur)
  const [panSens, setPanSens] = useState(DEFAULT_SENS)   // sensibilité déplacement en zoom
  const pageFlipRef = useRef(pageFlip)
  const sensRef = useRef(panSens)
  const fitWidthRef = useRef(fitWidth)
  const scrollRef = useRef()        // conteneur scrollable (mode fit largeur)
  const fitScrollRef = useRef(0)    // position de scroll voulue après changement de page
  const imgReadyRef = useRef(false)
  useEffect(() => { pageFlipRef.current = pageFlip }, [pageFlip])
  useEffect(() => { sensRef.current = panSens }, [panSens])
  useEffect(() => { fitWidthRef.current = fitWidth }, [fitWidth])
  useEffect(() => { imgReadyRef.current = imgReady }, [imgReady])

  // Charge les préférences de CET utilisateur (isolées des autres comptes)
  useEffect(() => {
    setScrollNav(localStorage.getItem(prefKey('scrollnav')) === '1')
    setPageFlip(localStorage.getItem(prefKey('pageflip')) === '1')
    setFitWidth(localStorage.getItem(prefKey('fitwidth')) === '1')
    const s = Number(localStorage.getItem(prefKey('pansens')))
    setPanSens(s > 0 ? s : DEFAULT_SENS)
  }, [uid]) // eslint-disable-line

  const togglePageFlip = () => setPageFlip((v) => { localStorage.setItem(prefKey('pageflip'), v ? '0' : '1'); return !v })
  const toggleFitWidth = () => setFitWidth((v) => {
    localStorage.setItem(prefKey('fitwidth'), v ? '0' : '1')
    if (!v) { setZoom(1); setPan({ x: 0, y: 0 }) }  // en entrant : on annule un éventuel zoom
    return !v
  })
  // Sensibilité : bouton qui cycle ×1 → ×1.5 → … → ×3 → ×1 (défaut ×1)
  const SENS_STEPS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]
  const cycleSens = () => {
    const i = SENS_STEPS.findIndex((v) => Math.abs(v - panSens) < 0.001)
    const next = SENS_STEPS[(i + 1) % SENS_STEPS.length]
    setPanSens(next); localStorage.setItem(prefKey('pansens'), String(next))
  }
  // Plein écran immersif : masque header/footer + plein écran natif (F11) sur desktop
  const enterFullscreen = () => {
    setFullscreen(true)
    try { document.documentElement.requestFullscreen?.() } catch { /* iOS: non supporté */ }
  }
  const exitFullscreen = () => {
    setFullscreen(false)
    try { if (document.fullscreenElement) document.exitFullscreen?.() } catch { /* noop */ }
  }
  useEffect(() => {
    const h = () => { if (!document.fullscreenElement) setFullscreen(false) }
    document.addEventListener('fullscreenchange', h)
    return () => document.removeEventListener('fullscreenchange', h)
  }, [])

  // Zoom géré par l'app (pas le navigateur) : double-tap pour zoomer, glisser pour naviguer.
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [origin, setOrigin] = useState({ x: 0, y: 0 })
  const zoomed = zoom > 1
  const imgRef = useRef()
  const flipRef = useRef()    // conteneur qui pivote (page)
  const shadeRef = useRef()   // ombre en dégradé qui balaie la page
  const num = Number(chapterNum)
  const lastTapRef = useRef({ t: 0, x: 0, y: 0 })
  const panStartRef = useRef(null)
  const touchStartRef = useRef({ x: 0, y: 0 })
  const touchMovedRef = useRef(false)

  // Réinitialise le zoom à chaque changement de page / chapitre
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [current, chapterNum])

  // Précharge plusieurs planches en avant (+ une en arrière) → moins d'attente au changement
  // de page, surtout sur mobile où le serveur extrait la planche de l'EPUB.
  useEffect(() => {
    if (!images.length) return
    for (const i of [current + 1, current + 2, current + 3, current + 4, current - 1]) {
      if (i >= 0 && i < images.length) { const im = new Image(); im.src = images[i] }
    }
  }, [current, images])

  // Image déjà en cache (préchargée) : onLoad ne se déclenche PAS → sans ça on resterait
  // bloqué en "non prêt" = écran noir. On vérifie .complete après montage.
  useEffect(() => {
    const im = imgRef.current
    if (im && im.complete && im.naturalWidth > 0) {
      setImgReady(true)
      if (fitWidthRef.current && fitScrollRef.current === 'bottom' && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        fitScrollRef.current = 0
      }
    }
  }, [current, chapterNum, images, fitWidth])

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
    setScrollNav((v) => { localStorage.setItem(prefKey('scrollnav'), v ? '0' : '1'); return !v })
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

  // Direction de la prochaine transition (posée par goNext/goPrev), jouée APRÈS le montage
  // de la nouvelle image (sinon l'anim s'exécute sur l'ancienne planche → invisible).
  const animateRef = useRef(null)
  const slide = useCallback((dir) => { animateRef.current = dir }, [])

  useLayoutEffect(() => {
    const dir = animateRef.current
    animateRef.current = null
    // Mode fit-largeur : pas d'anim de flip, on repositionne le scroll (haut pour suivant,
    // bas pour précédent — le bas est appliqué à la fin du chargement de l'image).
    if (fitWidthRef.current) {
      if (scrollRef.current) {
        if (dir === -1 && current > 0) { fitScrollRef.current = 'bottom' }  // page précédente → bas
        else { scrollRef.current.scrollTop = 0; fitScrollRef.current = 0 }  // sinon → haut
      }
      return
    }
    const el = flipRef.current
    if (dir == null || !el) return
    if (pageFlipRef.current) {
      // Vraie page qui se tourne (façon turn.js / StPageFlip) :
      // pivot autour de la reliure (proche 90°, sous perspective) + ombre en dégradé
      // qui balaie la page et s'estompe quand elle se replie à plat.
      const originX = dir === 1 ? 'left' : 'right'
      const shade = shadeRef.current
      if (shade) {
        shade.style.background = dir === 1
          ? 'linear-gradient(90deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,.12) 35%, rgba(0,0,0,0) 60%)'
          : 'linear-gradient(270deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,.12) 35%, rgba(0,0,0,0) 60%)'
      }
      const tl = gsap.timeline()
      tl.fromTo(el,
        { rotationY: dir === 1 ? 96 : -96 },
        { rotationY: 0, duration: .62, ease: 'power2.out',
          transformOrigin: `${originX} center`, clearProps: 'transform' }, 0)
      if (shade) {
        tl.fromTo(shade, { opacity: .9 }, { opacity: 0, duration: .62, ease: 'power1.in' }, 0)
      }
    } else {
      gsap.fromTo(el,
        { x: dir === 1 ? -20 : 20 },
        { x: 0, duration: .18, ease: 'power2.out', clearProps: 'transform' })
    }
  }, [current, chapterNum])

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
    if (zoomed) return
    if (fitWidth) {
      // Défilement natif dans la planche ; on ne change de page qu'en début/fin de planche,
      // et seulement si le mode molette est actif (cohabitation des deux mécaniques).
      if (!scrollNav) return
      if (!imgReadyRef.current) return   // planche pas encore chargée → pas de saut de page
      const el = scrollRef.current
      if (!el) return
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 3
      const atTop = el.scrollTop <= 3
      const now = Date.now()
      if (now - wheelLock.current < 350) return
      if (e.deltaY > 0 && atBottom) { wheelLock.current = now; goNext() }
      else if (e.deltaY < 0 && atTop) { wheelLock.current = now; goPrev() }
      return
    }
    if (!scrollNav) return
    const now = Date.now()
    if (now - wheelLock.current < 350) return       // 1 cran = 1 page
    if (Math.abs(e.deltaY) < 12) return
    wheelLock.current = now
    if (e.deltaY > 0) goNext(); else goPrev()
  }, [scrollNav, zoomed, fitWidth, goNext, goPrev])

  // ── Gestes tactiles : tap latéral = page, double-tap = zoom, glisser = pan/swipe ──
  const onTouchStart = useCallback((e) => {
    const t = e.touches[0]
    touchStartRef.current = { x: t.clientX, y: t.clientY }
    if (fitWidthRef.current) return   // mode défilement : scroll natif (on garde juste startY)
    touchMovedRef.current = false
    if (zoomed) panStartRef.current = { px: pan.x, py: pan.y, tx: t.clientX, ty: t.clientY }
  }, [zoomed, pan])

  const onTouchMove = useCallback((e) => {
    if (fitWidthRef.current) return
    if (zoomed && panStartRef.current) {
      const t = e.touches[0]
      const dx = t.clientX - panStartRef.current.tx
      const dy = t.clientY - panStartRef.current.ty
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) touchMovedRef.current = true
      const s = sensRef.current   // sensibilité réglable (vitesse de déplacement en zoom)
      setPan({ x: panStartRef.current.px + dx * s, y: panStartRef.current.py + dy * s })
    }
  }, [zoomed])

  const onTouchEnd = useCallback((e) => {
    const t = e.changedTouches[0]
    if (fitWidthRef.current) {
      // Mode défilement : le tap est géré par onAreaClick. Ici on gère le SWIPE vertical
      // qui tourne la page — aux extrémités de la planche, ou si elle tient à l'écran.
      // Seulement si le mode molette/scroll est actif (cohabitation).
      if (!scrollNav) return
      if (!imgReadyRef.current) return   // planche pas encore chargée → pas de saut de page
      const el = scrollRef.current
      if (!el) return
      const dy = t.clientY - touchStartRef.current.y
      if (Math.abs(dy) < 40) return   // tap → onAreaClick
      const fits = el.scrollHeight <= el.clientHeight + 3
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 3
      const atTop = el.scrollTop <= 3
      if (dy < 0 && (fits || atBottom)) goNext()        // swipe vers le haut → suivant
      else if (dy > 0 && (fits || atTop)) goPrev()      // swipe vers le bas → précédent
      return
    }
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
    // double-tap → zoome (n'importe où)
    if (isDouble) { lastTapRef.current = { t: 0, x: 0, y: 0 }; toggleZoomAt(t.clientX, t.clientY); return }
    lastTapRef.current = { t: now, x: t.clientX, y: t.clientY }
    // Navigation par tap latéral — DÉSACTIVÉE quand le mode scroll est actif
    if (!scrollNav) {
      const x = t.clientX - r.left
      if (x < r.width * 0.33) goPrev()          // tiers gauche → précédent
      else if (x > r.width * 0.67) goNext()     // tiers droit → suivant
    }
  }, [zoomed, scrollNav, goNext, goPrev, pan]) // eslint-disable-line

  // Clic latéral = changement de page
  const onAreaClick = useCallback((e) => {
    if (zoomed) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    if (fitWidth) {   // mode défilement
      if (scrollNav) return   // molette active → nav par scroll/swipe uniquement (pas de doublon)
      if (x < r.width * 0.30) goPrev()          // sinon : tap latéral change de page (souris + tactile)
      else if (x > r.width * 0.70) goNext()
      return
    }
    if (IS_TOUCH || scrollNav) return   // mode scroll actif → pas de nav au clic
    if (x < r.width * 0.33) goPrev()
    else if (x > r.width * 0.67) goNext()
  }, [zoomed, scrollNav, fitWidth, goPrev, goNext])
  const onAreaDblClick = useCallback((e) => {
    if (IS_TOUCH || fitWidth) return   // pas de zoom double-clic en mode défilement
    toggleZoomAt(e.clientX, e.clientY)
  }, [zoomed, fitWidth]) // eslint-disable-line

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
        <button onClick={toggleFitWidth}
          title={fitWidth ? 'Lecture défilement (fit largeur) : ON' : 'Lecture défilement (fit largeur) : OFF'}
          style={{ color: fitWidth ? '#e50914' : 'rgba(255,255,255,.6)', padding: '.28rem .42rem',
            background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4, cursor: 'pointer',
            display: 'flex', alignItems: 'center' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="3" width="16" height="18" rx="1"/><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/>
          </svg>
        </button>
        <button onClick={enterFullscreen} title="Plein écran"
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
        ref={scrollRef}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={onAreaClick}
        onDoubleClick={onAreaDblClick}
        style={{
          flex: 1, position: 'relative', background: '#000',
          display: 'flex', justifyContent: 'center',
          ...(fitWidth
            ? {
              // Mode défilement : image ajustée à la largeur, scroll vertical natif
              overflowY: 'auto', overflowX: 'hidden', alignItems: 'flex-start',
              touchAction: 'pan-y',
            }
            : {
              overflow: 'hidden', alignItems: 'center',
              touchAction: 'none',    // on gère nous-mêmes zoom/pan
              perspective: '2200px',  // profondeur 3D pour la page qui se tourne
            }),
        }}
      >
        {!loaded && (
          <div style={{ color: 'rgba(255,255,255,.3)', fontSize: '.88rem', display: 'flex', gap: '.5rem', alignItems: 'center', margin: 'auto' }}>
            <div className="spin" /> Chargement…
          </div>
        )}
        {loaded && images.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,.3)', margin: 'auto' }}>Aucune image trouvée</div>
        )}
        {loaded && images.length > 0 && (
          fitWidth ? (
            /* Mode défilement : planche pleine largeur, on la parcourt verticalement */
            <>
              {!imgReady && (
                <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                  display: 'flex', alignItems: 'center', gap: '.5rem', color: 'rgba(255,255,255,.55)', fontSize: '.82rem',
                  background: 'rgba(0,0,0,.5)', padding: '.5rem .8rem', borderRadius: 6, zIndex: 5 }}>
                  <div className="spin" /> Chargement…
                </div>
              )}
              {/* key STABLE : l'élément persiste → le navigateur garde la planche précédente
                  affichée pendant que la nouvelle charge (jamais d'écran noir). */}
              <img
                ref={imgRef}
                key="fit-page"
                src={images[current]}
                alt=""
                onLoad={() => {
                  setImgReady(true)
                  if (fitScrollRef.current === 'bottom' && scrollRef.current) {
                    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
                    fitScrollRef.current = 0
                  }
                }}
                onError={() => setImgReady(true)}
                draggable={false}
                style={{ width: '100%', height: 'auto', display: 'block', userSelect: 'none', margin: 'auto 0' }}
              />
            </>
          ) : (
            <>
              {!imgReady && <div className="spin" style={{ position: 'absolute' }} />}
              {/* Conteneur "page" qui pivote (flip) + ombre en dégradé par-dessus */}
              <div ref={flipRef} className="reader-flip">
                <img
                  ref={imgRef}
                  key={images[current]}
                  src={images[current]}
                  alt={`Page ${current + 1}`}
                  onLoad={() => setImgReady(true)}
                  onError={() => setImgReady(true)}
                  draggable={false}
                  style={{
                    maxHeight: '100%', maxWidth: '100%',
                    objectFit: 'contain', display: 'block',
                    opacity: imgReady ? 1 : 0,
                    userSelect: 'none', cursor: zoomed ? 'grab' : 'default',
                    backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden',
                    ...(zoomed
                      ? {
                        transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                        transformOrigin: `${origin.x}px ${origin.y}px`,
                        transition: 'none',
                        willChange: 'transform',
                      }
                      : { transition: 'opacity .12s' }),
                  }}
                />
                <div ref={shadeRef} className="reader-flip-shade" />
              </div>
            </>
          )
        )}
      </div>

      {/* Bouton flottant pour quitter le plein écran */}
      {fullscreen && (
        <button onClick={exitFullscreen} className="reader-fs-exit" title="Quitter le plein écran">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>
          </svg>
        </button>
      )}

      {/* Plein écran : barre de progression rouge en bas, toute la largeur */}
      {fullscreen && loaded && images.length > 0 && (
        <div className="reader-fs-progress">
          <div style={{ width: `${((current + 1) / images.length) * 100}%` }} />
        </div>
      )}

      {/* Bottom bar */}
      <div className="reader-bottombar" style={{
        flexShrink: 0, height: 44, position: 'relative',
        display: fullscreen ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', gap: '1.5rem',
        background: 'rgba(0,0,0,.9)', borderTop: '1px solid rgba(255,255,255,.08)',
      }}>
        {/* Sensibilité du déplacement en zoom — bouton qui cycle ×1 → ×3 (tout à gauche) */}
        <button onClick={cycleSens}
          title={`Vitesse de déplacement en zoom : ×${panSens} (cliquer pour changer)`}
          style={{ position: 'absolute', left: '.8rem', top: 22, transform: 'translateY(-50%)',
            display: 'flex', alignItems: 'center', gap: '.3rem',
            color: panSens > 1 ? '#e50914' : 'rgba(255,255,255,.6)',
            background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4,
            padding: '.28rem .5rem', cursor: 'pointer', fontSize: '.74rem', fontWeight: 700 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20a8 8 0 1 0-8-8"/><path d="M12 12l4-2"/>
          </svg>
          ×{panSens}
        </button>
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
        {/* Toggle animation "page qui se tourne" — tout à droite */}
        <button onClick={togglePageFlip}
          title={pageFlip ? 'Animation page : ON' : 'Animation page : OFF'}
          style={{ position: 'absolute', right: '.8rem', top: 22, transform: 'translateY(-50%)',
            color: pageFlip ? '#e50914' : 'rgba(255,255,255,.55)',
            background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4,
            padding: '.32rem .42rem', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
          </svg>
        </button>
      </div>
    </div>
  )
}
