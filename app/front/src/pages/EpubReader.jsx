import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useContext, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { gsap } from 'gsap'
import { api } from '../api/client'
import { AuthCtx } from '../contexts'
import { loadReaderSettings } from '../readerSettings'
import { loadProfiles, resolveProfileId, getProfile, saveProfiles } from '../readerProfiles'
import { createAmbienceEngine } from '../ambienceAudio'

const IS_TOUCH = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches
const ZOOM_LEVEL = 2.5
const DEFAULT_SENS = 1        // sensibilité de déplacement en zoom par défaut (= vitesse actuelle)
// Auto-scroll (mode fit-largeur) : px/s par niveau — commence TRÈS lent
const AUTO_SPEEDS = [8, 16, 28, 46, 72, 110]
// Mise à l'échelle (mode fit-largeur) — 100% = max (ajusté largeur), on réduit pour adapter
const ZOOM_PERCENTS = [100, 90, 80, 70, 60, 50]
// Préchargement des planches en FENÊTRE GLISSANTE : on garde toujours PREFETCH_AHEAD
// pages prêtes en avant + PREFETCH_BEHIND en arrière (nav retour rapide). Le navigateur
// évince tout seul les pages sorties de la fenêtre → rien ne s'accumule.
const PREFETCH_AHEAD = 6
const PREFETCH_BEHIND = 2

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
  const [autoScroll, setAutoScroll] = useState(false)    // défilement auto (fit largeur)
  const [autoLevel, setAutoLevel] = useState(1)          // niveau de vitesse 1..6
  const [zoomPct, setZoomPct] = useState(100)            // niveau de zoom double-tap (%)
  const pageFlipRef = useRef(pageFlip)
  const sensRef = useRef(panSens)
  const fitWidthRef = useRef(fitWidth)
  const autoLevelRef = useRef(autoLevel)
  const zoomPctRef = useRef(zoomPct)
  const autoPausedRef = useRef(false)   // pause momentanée quand on touche l'écran
  const autoCooldownRef = useRef(0)     // pause de bord de planche (survit au redémarrage d'effet)
  const autoAdvancePendingRef = useRef(false)  // en pause "fin de planche", avant d'avancer
  const autoStartPauseRef = useRef(false)      // pause de DÉBUT à armer quand la planche devient visible
  const autoScrollRef = useRef(false)          // lecture de autoScroll sans re-déclencher les effets
  const wheelPauseTimer = useRef()
  useEffect(() => { autoLevelRef.current = autoLevel }, [autoLevel])
  useEffect(() => { zoomPctRef.current = zoomPct }, [zoomPct])
  useEffect(() => { autoScrollRef.current = autoScroll }, [autoScroll])

  // Profils de lecture (synchronisés par compte). Le profil ACTIF (résolu par manga) pilote
  // quelles options sont visibles + leurs valeurs → on en dérive l'objet `settings` que le
  // reste du reader consomme déjà (boutons visibles, plages, pause auto-scroll).
  const [profStore, setProfStore] = useState(null)
  const [activeProfileId, setActiveProfileId] = useState('default')
  const [showReaderMenu, setShowReaderMenu] = useState(false)
  const [sheetExpanded, setSheetExpanded] = useState(false)   // bottom-sheet plié (55vh) ⇄ étendu (92vh)
  useEffect(() => {
    let alive = true
    loadProfiles(uid).then((st) => {
      if (!alive) return
      setProfStore(st); setActiveProfileId(resolveProfileId(st, mangaId))
    })
    return () => { alive = false }
  }, [uid, mangaId])
  const profile = useMemo(() => (profStore ? getProfile(profStore, activeProfileId) : null), [profStore, activeProfileId])
  const zoomGesture = profile?.zoomGesture || 'both'
  const settings = useMemo(() => {
    if (!profile) return loadReaderSettings(uid)
    return {
      buttons: { ...profile.visible, fullscreen: true },
      scaleLevels: profile.values.scaleLevels,
      sensLevels: profile.values.sensLevels,
      speedLevels: profile.values.speedLevels,
      autoEdgePause: profile.defaults?.autoEdgePause || 0,
    }
  }, [profile, uid])
  // Change de profil pour CE manga (propre à l'utilisateur, persisté backend).
  const selectProfile = (id) => {
    setActiveProfileId(id)
    setProfStore((prev) => {
      if (!prev) return prev
      const next = { ...prev, activeId: id, perManga: { ...prev.perManga, [mangaId]: id } }
      saveProfiles(next)
      return next
    })
    // On NE ferme PAS : les commandes du profil sont dans ce même panneau (comme NeoReader).
  }
  const speedLevelsRef = useRef(settings.speedLevels)
  const autoEdgePauseRef = useRef(settings.autoEdgePause)
  useEffect(() => {
    speedLevelsRef.current = settings.speedLevels
    autoEdgePauseRef.current = settings.autoEdgePause
  }, [settings])
  const scrollRef = useRef()        // conteneur scrollable (mode fit largeur)
  const fitScrollRef = useRef(0)    // position de scroll voulue après changement de page
  const imgReadyRef = useRef(false)
  useEffect(() => { pageFlipRef.current = pageFlip }, [pageFlip])
  useEffect(() => { sensRef.current = panSens }, [panSens])
  useEffect(() => { fitWidthRef.current = fitWidth }, [fitWidth])
  useEffect(() => { imgReadyRef.current = imgReady }, [imgReady])

  // ── Ambiance sonore : segments détectés + moteur audio synthétisé (Web Audio) ──
  const [ambSegments, setAmbSegments] = useState(null)   // [{from,to,ambience,layers,action}] | null
  const [ambActions, setAmbActions] = useState(null)     // score d'action PAR planche (len==pages)
  const [ambOn, setAmbOn] = useState(false)
  const ambEngineRef = useRef(null)
  // récupère les segments du chapitre (silencieux si non analysé)
  useEffect(() => {
    setAmbSegments(null); setAmbActions(null)
    api.getAmbience(mangaId, chapterNum)
      .then((d) => { setAmbSegments(d?.segments || null); setAmbActions(Array.isArray(d?.actions) ? d.actions : null) })
      .catch(() => { setAmbSegments(null); setAmbActions(null) })
  }, [mangaId, chapterNum])
  // Couches de la planche courante : le DÉCOR vient du segment RLE ; la surcouche « ACTION »
  // se décide PLANCHE PAR PLANCHE depuis `actions` (le décor peut contenir des planches calmes
  // ET des planches d'action). Dilatation ±1 planche pour attraper le pic sans clignoter.
  // Repli sur les vieux `layers` si le chapitre n'a pas encore le tableau `actions`.
  const ACTION_GATE = 0.50
  const currentLayers = useMemo(() => {
    if (!ambSegments) return null
    const s = ambSegments.find((x) => current >= x.from && current <= x.to)
    if (!s) return null
    const decor = s.ambience || (s.layers || []).find((l) => l !== 'action') || 'interieur'
    const out = [decor]
    let bigMove
    if (ambActions && ambActions.length) {
      const a = (k) => (k >= 0 && k < ambActions.length ? (ambActions[k] || 0) : 0)
      bigMove = Math.max(a(current - 1), a(current), a(current + 1)) >= ACTION_GATE
    } else {
      bigMove = (s.layers || []).includes('action')   // vieux chapitres : comportement d'avant
    }
    if (bigMove && decor !== 'action') out.push('action')
    return out
  }, [ambSegments, ambActions, current])
  // clé stable pour ne (re)piloter le moteur qu'au vrai changement de couches
  const layerKey = currentLayers ? currentLayers.join('+') : ''
  // pilote le moteur : (ré)active + mixe les couches au fil des planches (crossfade)
  useEffect(() => {
    if (!ambOn) return
    if (!ambEngineRef.current) ambEngineRef.current = createAmbienceEngine()
    let cancelled = false
    const arr = layerKey ? layerKey.split('+') : ['interieur']
    ambEngineRef.current.enable().then(() => { if (!cancelled) ambEngineRef.current.setLayers(arr) })
    return () => { cancelled = true }
  }, [ambOn, layerKey])
  useEffect(() => { if (!ambOn) ambEngineRef.current?.stop() }, [ambOn])
  useEffect(() => () => { ambEngineRef.current?.stop() }, [])
  // Activation par session (le tap = geste utilisateur requis pour démarrer l'audio).
  const toggleAmbience = () => setAmbOn((v) => !v)

  // ── Liaison profil ⇄ état VIVANT ──
  // Le profil ACTIF porte l'état réellement actif (échelle, fit, vitesse…). On l'APPLIQUE aux
  // commandes à l'ouverture / au changement de profil, et on le RÉÉCRIT à chaque changement dans
  // le lecteur → synchronisé par compte (retrouvé tel quel sur tout appareil / manga du profil).
  const activeProfileIdRef = useRef(activeProfileId)
  useEffect(() => { activeProfileIdRef.current = activeProfileId }, [activeProfileId])
  const saveTimerRef = useRef(null)
  const scheduleSave = (store) => {
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => saveProfiles(store), 600)  // débounce l'écriture backend
  }
  const patchActiveState = (patch) => {
    setProfStore((prev) => {
      if (!prev) return prev
      const id = activeProfileIdRef.current
      const p = prev.profiles[id]; if (!p) return prev
      const next = { ...prev, profiles: { ...prev.profiles, [id]: { ...p, state: { ...(p.state || {}), ...patch } } } }
      scheduleSave(next)
      return next
    })
  }
  // Applique l'état du profil aux commandes — SEULEMENT au 1er chargement / changement de profil
  // (garde `appliedProfRef`), pour ne pas écraser un réglage qu'on vient de toucher en direct.
  const appliedProfRef = useRef(null)
  useEffect(() => {
    if (!profile) return
    if (appliedProfRef.current === activeProfileId) return
    const st = profile.state || {}
    setScrollNav(!!st.scrollnav)
    setPageFlip(!!st.flip)
    setFitWidth(!!st.fitwidth)
    setAutoScroll(!!st.autoscroll)
    setZoomPct(st.scale >= 40 && st.scale <= 100 ? st.scale : 100)
    setPanSens(st.sens > 0 ? st.sens : DEFAULT_SENS)
    const idx = (profile.values?.speedLevels || []).indexOf(st.speed)
    setAutoLevel(idx >= 0 ? idx + 1 : 1)
    if (!st.fitwidth) { setZoom(1); setPan({ x: 0, y: 0 }) }
    appliedProfRef.current = activeProfileId
  }, [profile, activeProfileId])

  const cycleAutoSpeed = () => {
    const levels = settings.speedLevels
    setAutoLevel((v) => { const next = (v % levels.length) + 1; patchActiveState({ speed: levels[next - 1] }); return next })
  }
  const setSpeedValue = (val) => { const i = settings.speedLevels.indexOf(val); setAutoLevel(i >= 0 ? i + 1 : 1); patchActiveState({ speed: val }) }
  const toggleAutoScroll = () => setAutoScroll((v) => { patchActiveState({ autoscroll: !v }); return !v })
  const cycleZoom = () => {
    const levels = settings.scaleLevels
    setZoomPct((v) => { const i = levels.indexOf(v); const next = levels[(i + 1) % levels.length]; patchActiveState({ scale: next }); return next })
  }
  const setScaleValue = (val) => { setZoomPct(val); patchActiveState({ scale: val }) }
  const togglePageFlip = () => setPageFlip((v) => { patchActiveState({ flip: !v }); return !v })
  const toggleFitWidth = () => setFitWidth((v) => {
    if (!v) { setZoom(1); setPan({ x: 0, y: 0 }) }  // en entrant : on annule un éventuel zoom
    patchActiveState({ fitwidth: !v })
    return !v
  })
  const cycleSens = () => {
    const steps = settings.sensLevels
    const i = steps.findIndex((v) => Math.abs(v - panSens) < 0.001)
    const next = steps[(i + 1) % steps.length]
    setPanSens(next); patchActiveState({ sens: next })
  }
  const setSensValue = (val) => { setPanSens(val); patchActiveState({ sens: val }) }
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
  const pinchRef = useRef(null)             // pincement 2 doigts en cours : { d0, dLast, cx, cy }
  const zoomGestureRef = useRef('both')     // geste de zoom du profil (lu sans re-créer les handlers)
  useEffect(() => { zoomGestureRef.current = zoomGesture }, [zoomGesture])

  // Réinitialise le zoom à chaque changement de page / chapitre
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [current, chapterNum])

  // Préchargement PAR BATCH avec RÉTENTION des Image() en vol. Un `new Image()` non
  // référencé peut voir son téléchargement ANNULÉ par le GC → on retombe sur "Chargement"
  // en arrivant sur la planche. On garde donc la réf tant que l'image n'est pas chargée,
  // et on lance le batch SUIVANT dès qu'on atteint la moitié du batch courant (mi-batch).
  const prefetchRef = useRef(new Map())     // index → HTMLImageElement (gardé tant qu'en vol)
  // Nouveau chapitre → on décharge tout le préchargement (« œuvre lue = déchargée »).
  useEffect(() => { prefetchRef.current.clear() }, [images])
  useEffect(() => {
    if (!images.length) return
    const map = prefetchRef.current
    const load = (i) => {
      if (i < 0 || i >= images.length || map.has(i)) return
      const im = new Image()
      im.decoding = 'async'
      im.onload = im.onerror = () => map.delete(i)   // chargé → reste en cache navigateur (compressé), on libère la réf JS
      im.src = images[i]
      map.set(i, im)                                  // rétention anti-annulation tant qu'en vol
    }
    // Fenêtre glissante : on demande toujours [current-BEHIND, current+AHEAD]. En avançant,
    // le batch suivant est déjà lancé ; les pages sorties de la fenêtre sont évincées par le
    // navigateur (cache compressé auto-géré) → mémoire bornée, avance fluide.
    const lo = Math.max(0, current - PREFETCH_BEHIND)
    const hi = Math.min(images.length - 1, current + PREFETCH_AHEAD)
    for (let i = lo; i <= hi; i++) load(i)
  }, [current, images])

  // Marque la planche comme prête : force le DÉCODAGE (sinon iOS peut afficher du noir
  // tant qu'on ne scrolle pas — décodage paresseux) puis repositionne le scroll.
  const markReady = useCallback(() => {
    const finish = () => {
      setImgReady(true)
      const el = scrollRef.current
      if (fitWidthRef.current && el) {
        if (fitScrollRef.current === 'bottom') {
          el.scrollTop = el.scrollHeight; fitScrollRef.current = 0
        } else {
          // nudge de 1px → force le rendu de la planche (contourne le décodage paresseux)
          requestAnimationFrame(() => { el.scrollTop = 1; requestAnimationFrame(() => { el.scrollTop = 0 }) })
        }
      }
    }
    const im = imgRef.current
    if (im && im.decode) im.decode().then(finish).catch(finish)
    else finish()
  }, [])

  // Image déjà en cache (préchargée) : onLoad ne se déclenche PAS → sans ça on resterait
  // bloqué en "non prêt" = écran noir. On vérifie .complete après montage.
  useEffect(() => {
    const im = imgRef.current
    if (im && im.complete && im.naturalWidth > 0) markReady()
  }, [current, chapterNum, images, fitWidth, markReady])

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
    setScrollNav((v) => { patchActiveState({ scrollnav: !v }); return !v })
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
  const currentRef = useRef(current)
  useEffect(() => { currentRef.current = current }, [current])
  useEffect(() => {
    if (!loaded || images.length === 0) return
    const t = setTimeout(() => {
      api.saveProgress(mangaId, num, current, images.length).catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [current, loaded, images.length, mangaId, num])

  // Sync cross-device : dès que l'app passe en arrière-plan (changement d'appareil/onglet)
  // ou se ferme, on FLUSH immédiatement le marque-page → l'autre appareil le lit à jour.
  useEffect(() => {
    const flush = () => {
      if (loaded && images.length > 0) {
        api.saveProgress(mangaId, num, currentRef.current, images.length).catch(() => {})
      }
    }
    const onVis = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', flush)
    }
  }, [loaded, images.length, mangaId, num])

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
      // molette manuelle → pause l'auto-scroll un instant, puis reprise
      autoPausedRef.current = true
      clearTimeout(wheelPauseTimer.current)
      wheelPauseTimer.current = setTimeout(() => { autoPausedRef.current = false }, 700)
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
    autoPausedRef.current = true   // toucher l'écran → pause l'auto-scroll
    if (fitWidthRef.current) return   // mode défilement : scroll natif (on garde juste startY)
    // Pincement (mode paginé) : 2 doigts → toggle zoom (si le geste est autorisé par le profil)
    const g = zoomGestureRef.current
    if (e.touches.length === 2 && (g === 'pinch' || g === 'both')) {
      const a = e.touches[0], b = e.touches[1]
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      pinchRef.current = { d0: d, dLast: d, cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 }
      return
    }
    touchMovedRef.current = false
    if (zoomed) panStartRef.current = { px: pan.x, py: pan.y, tx: t.clientX, ty: t.clientY }
  }, [zoomed, pan])

  const onTouchMove = useCallback((e) => {
    if (fitWidthRef.current) return
    if (pinchRef.current && e.touches.length === 2) {
      const a = e.touches[0], b = e.touches[1]
      pinchRef.current.dLast = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      pinchRef.current.cx = (a.clientX + b.clientX) / 2
      pinchRef.current.cy = (a.clientY + b.clientY) / 2
      return
    }
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
    // reprise de l'auto-scroll après un court délai (laisse retomber l'inertie iOS)
    clearTimeout(wheelPauseTimer.current)
    wheelPauseTimer.current = setTimeout(() => { autoPausedRef.current = false }, 350)
    // Fin d'un PINCEMENT → toggle zoom selon l'écartement des doigts
    if (pinchRef.current) {
      const { d0, dLast, cx, cy } = pinchRef.current
      pinchRef.current = null
      const ratio = dLast / (d0 || 1)
      if (!zoomed && ratio > 1.15) toggleZoomAt(cx, cy)                        // écartement → zoome
      else if (zoomed && ratio < 0.87) { setZoom(1); setPan({ x: 0, y: 0 }) }  // pincement → dézoome
      return
    }
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
    const dblG = zoomGestureRef.current
    const allowDbl = dblG === 'doubletap' || dblG === 'both'
    const isDouble = allowDbl && (now - last.t < 300) && Math.abs(t.clientX - last.x) < 45 && Math.abs(t.clientY - last.y) < 45
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

  // ── Auto-scroll (mode fit-largeur) : défilement doux, pause au toucher, avance de page ──
  // On modifie scrollTop par pixels ENTIERS (source de vérité = scrollTop) → respecte les
  // scrolls manuels, et le reste fractionnaire est reporté → fluide même très lent.
  useEffect(() => {
    if (!autoScroll || !fitWidth) return
    let raf, acc = 0, last = performance.now()
    const step = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now
      const el = scrollRef.current
      // autoCooldownRef survit au redémarrage de l'effet (goNext change `current` → restart)
      if (el && !autoPausedRef.current && imgReadyRef.current && now > autoCooldownRef.current) {
        const remaining = el.scrollHeight - el.clientHeight - el.scrollTop
        if (remaining <= 1) {
          const pauseMs = autoEdgePauseRef.current > 0 ? autoEdgePauseRef.current * 1000 : 900
          if (!autoAdvancePendingRef.current) {
            // 1) arrivé en bas → PAUSE de FIN de planche (on reste en bas)
            autoAdvancePendingRef.current = true
            autoCooldownRef.current = now + pauseMs
          } else {
            // 2) pause de fin écoulée → on avance. La pause de DÉBUT de la nouvelle planche
            //    est (ré)armée par l'effet de CHANGEMENT DE PLANCHE ci-dessous (manuel OU auto),
            //    quand la planche devient visible → jamais zappée par le temps de chargement.
            autoAdvancePendingRef.current = false
            acc = 0
            if (current < images.length - 1 || nextChapNum != null) goNext()
            else setAutoScroll(false)           // fin du chapitre sans suite → stop
          }
        } else {
          const speeds = speedLevelsRef.current
          acc += (speeds[autoLevelRef.current - 1] || speeds[0] || 8) * dt
          const px = Math.floor(acc)
          if (px > 0) { el.scrollTop += Math.min(px, remaining); acc -= px }
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [autoScroll, fitWidth, current, images.length, nextChapNum, goNext])

  // Désactive l'auto-scroll si on quitte le mode fit-largeur
  useEffect(() => { if (!fitWidth) setAutoScroll(false) }, [fitWidth])

  // CHANGEMENT DE PLANCHE (manuel souris/tactile OU auto) pendant l'auto-scroll : on remet le
  // compteur d'attente à ZÉRO → la pause de début s'applique aussi sur les changements manuels.
  // Un simple déplacement DANS la même planche ne change pas `current` → pas de remise à zéro,
  // l'auto reprend normalement sans attente. useLayoutEffect : posé avant la 1ʳᵉ frame de scroll.
  useLayoutEffect(() => {
    if (!autoScrollRef.current || !fitWidthRef.current) return
    autoStartPauseRef.current = true
    autoCooldownRef.current = performance.now() + 3600000   // gel jusqu'à ce que la planche soit prête
  }, [current])

  // Pause de DÉBUT de planche ARMÉE quand la planche devient VISIBLE (imgReady false→true),
  // pas au moment du goNext : une planche lente à charger ne "mange" plus la pause de début.
  useEffect(() => {
    if (!autoScroll || !fitWidth || !imgReady) return
    if (!autoStartPauseRef.current) return
    autoStartPauseRef.current = false
    const p = autoEdgePauseRef.current > 0 ? autoEdgePauseRef.current * 1000 : 900
    autoCooldownRef.current = performance.now() + p
  }, [imgReady, autoScroll, fitWidth])

  // Activation de l'auto-scroll : pause de début. Si la planche est encore en chargement,
  // on diffère (l'effet ci-dessus l'armera quand elle sera visible → jamais zappée).
  useEffect(() => {
    autoAdvancePendingRef.current = false
    if (!autoScroll) return
    const p = autoEdgePauseRef.current > 0 ? autoEdgePauseRef.current * 1000 : 400
    if (imgReadyRef.current) {
      autoStartPauseRef.current = false
      autoCooldownRef.current = performance.now() + p
    } else {
      autoStartPauseRef.current = true                 // planche en chargement → pause différée
      autoCooldownRef.current = performance.now() + 3600000
    }
  }, [autoScroll])

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
        <span className="reader-title" style={{ color: 'rgba(255,255,255,.5)', fontSize: '.82rem',
          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {manga?.name} — Chap. {chapterNum}
        </span>
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
        <button onClick={() => setShowReaderMenu(true)} title="Options de lecture / profil"
          style={{ color: 'rgba(255,255,255,.6)', padding: '.28rem .42rem',
            background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4, cursor: 'pointer',
            display: 'flex', alignItems: 'center' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        {ambSegments && (
          <button onClick={toggleAmbience}
            title={ambOn ? 'Ambiance sonore : ON — clique pour couper' : 'Ambiance sonore détectée — clique pour activer le son'}
            style={{ display: 'flex', alignItems: 'center', gap: '.3rem',
              color: ambOn ? '#e50914' : 'rgba(255,255,255,.55)',
              background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4,
              padding: '.22rem .5rem', cursor: 'pointer', fontSize: '.72rem', fontWeight: 700 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
              <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
            </svg>
            {layerKey || '—'}
          </button>
        )}
        <span className="reader-hcount" style={{ color: 'rgba(255,255,255,.35)', fontSize: '.78rem' }}>
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
              // Mode défilement : image ajustée à la largeur (× zoomPct), scroll vertical natif
              // (+ horizontal si la planche est agrandie au-delà de 100%)
              overflowY: 'auto', overflowX: zoomPct > 100 ? 'auto' : 'hidden',
              alignItems: 'flex-start',
              touchAction: zoomPct > 100 ? 'pan-x pan-y' : 'pan-y',
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
                decoding="sync"
                onLoad={markReady}
                onError={() => setImgReady(true)}
                draggable={false}
                style={{ width: `${zoomPct}%`, height: 'auto', display: 'block', userSelect: 'none', margin: 'auto 0', flexShrink: 0 }}
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

      {/* Plein écran : boutons flottants (quitter + ⚙️ options). Tout le reste est dans le sheet. */}
      {fullscreen && (
        <div style={{ position: 'fixed', top: 12, right: 12, zIndex: 60, display: 'flex', gap: '.4rem' }}>
          <button onClick={() => setShowReaderMenu(true)} className="reader-fs-exit" title="Options de lecture / profil"
            style={{ position: 'static' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          <button onClick={exitFullscreen} className="reader-fs-exit" title="Quitter le plein écran"
            style={{ position: 'static' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>
            </svg>
          </button>
        </div>
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

      {showReaderMenu && profStore && (() => {
        const vis = profile?.visible || {}
        // Styles partagés du panneau (DRY)
        const section = { marginBottom: '1rem' }
        const label = { fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.04em',
          color: 'rgba(255,255,255,.45)', fontWeight: 700, marginBottom: '.45rem' }
        const chipRow = { display: 'flex', flexWrap: 'wrap', gap: '.4rem' }
        const chip = (on) => ({ padding: '.4rem .8rem', borderRadius: 18, border: 'none', cursor: 'pointer',
          fontSize: '.82rem', fontWeight: 700, background: on ? '#e50914' : 'rgba(255,255,255,.1)', color: '#fff' })
        const toggleRow = (on) => ({ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '.7rem .85rem', borderRadius: 10, border: 'none', cursor: 'pointer',
          background: 'rgba(255,255,255,.06)', color: '#fff', fontSize: '.88rem', fontWeight: 600, marginBottom: '.5rem' })
        const pill = (on) => ({ fontSize: '.72rem', fontWeight: 800, padding: '.18rem .6rem', borderRadius: 12,
          background: on ? '#e50914' : 'rgba(255,255,255,.14)', color: on ? '#fff' : 'rgba(255,255,255,.6)' })
        return (
        <div onClick={(e) => { if (e.target === e.currentTarget) setShowReaderMenu(false) }}
          style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,.55)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ width: '100%', maxWidth: 560, background: '#17171b',
            borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: '.5rem 1.1rem 1.6rem',
            boxShadow: '0 -8px 40px rgba(0,0,0,.6)', display: 'flex', flexDirection: 'column',
            height: sheetExpanded ? '92vh' : '58vh', maxHeight: '92vh', transition: 'height .25s ease' }}>
            {/* Poignée : glisser/cliquer pour étendre ou replier */}
            <button onClick={() => setSheetExpanded((v) => !v)} title={sheetExpanded ? 'Replier' : 'Étendre'}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '.35rem 0 .55rem', margin: '0 auto', display: 'block' }}>
              <div style={{ width: 42, height: 4, borderRadius: 2, background: 'rgba(255,255,255,.25)', margin: '0 auto' }} />
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.7rem', flexShrink: 0 }}>
              <div style={{ fontWeight: 800, fontSize: '1.02rem' }}>Lecture</div>
              <div style={{ display: 'flex', gap: '.3rem', alignItems: 'center' }}>
                <button onClick={() => setSheetExpanded((v) => !v)} title={sheetExpanded ? 'Replier' : 'Étendre'}
                  style={{ background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 6, color: 'rgba(255,255,255,.7)', cursor: 'pointer', padding: '.25rem .4rem', display: 'flex' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {sheetExpanded ? <polyline points="6 15 12 9 18 15"/> : <polyline points="6 9 12 15 18 9"/>}
                  </svg>
                </button>
                <button onClick={() => setShowReaderMenu(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.6)', fontSize: '1.2rem', cursor: 'pointer', padding: '0 .2rem' }}>✕</button>
              </div>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: '.2rem' }}>
              {/* Profil actif pour CE manga (propre à l'utilisateur, synchronisé) */}
              <div style={section}>
                <div style={{ ...label, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Profil de ce manga</span>
                  <span onClick={() => navigate('/settings')} style={{ cursor: 'pointer', color: 'rgba(255,255,255,.55)', textTransform: 'none', letterSpacing: 0 }}>Gérer ›</span>
                </div>
                <div style={chipRow}>
                  {Object.values(profStore.profiles).map((p) => (
                    <button key={p.id} onClick={() => selectProfile(p.id)} style={chip(p.id === activeProfileId)}>
                      {p.name}{p.id === profStore.defaultId ? ' ★' : ''}
                    </button>
                  ))}
                </div>
              </div>

              {/* Bascules d'affichage/lecture */}
              {vis.fitwidth && (
                <button onClick={toggleFitWidth} style={toggleRow(fitWidth)}>
                  <span>Mode défilement (fit largeur)</span><span style={pill(fitWidth)}>{fitWidth ? 'ON' : 'OFF'}</span>
                </button>
              )}
              {vis.scrollnav && (
                <button onClick={toggleScrollNav} style={toggleRow(scrollNav)}>
                  <span>Navigation à la molette</span><span style={pill(scrollNav)}>{scrollNav ? 'ON' : 'OFF'}</span>
                </button>
              )}
              {vis.flip && (
                <button onClick={togglePageFlip} style={toggleRow(pageFlip)}>
                  <span>Animation page qui se tourne</span><span style={pill(pageFlip)}>{pageFlip ? 'ON' : 'OFF'}</span>
                </button>
              )}
              {vis.autoscroll && (
                <button onClick={toggleAutoScroll} style={toggleRow(autoScroll)}>
                  <span>Défilement auto</span><span style={pill(autoScroll)}>{autoScroll ? 'ON' : 'OFF'}</span>
                </button>
              )}

              {/* Vitesses (liées au défilement auto) */}
              {vis.autoscroll && (
                <div style={section}>
                  <div style={label}>Vitesse du défilement auto</div>
                  <div style={chipRow}>
                    {settings.speedLevels.map((v, i) => (
                      <button key={v} onClick={() => setSpeedValue(v)} style={chip(autoLevel === i + 1)}>V{i + 1}</button>
                    ))}
                  </div>
                </div>
              )}

              {/* Échelle de planche */}
              {vis.scale && (
                <div style={section}>
                  <div style={label}>Taille de planche</div>
                  <div style={chipRow}>
                    {settings.scaleLevels.map((v) => (
                      <button key={v} onClick={() => setScaleValue(v)} style={chip(zoomPct === v)}>{v}%</button>
                    ))}
                  </div>
                </div>
              )}

              {/* Sensibilité de déplacement en zoom */}
              {vis.sensitivity && (
                <div style={section}>
                  <div style={label}>Sensibilité en zoom</div>
                  <div style={chipRow}>
                    {settings.sensLevels.map((v) => (
                      <button key={v} onClick={() => setSensValue(v)} style={chip(Math.abs(panSens - v) < 0.001)}>×{v}</button>
                    ))}
                  </div>
                </div>
              )}

              {/* Plein écran — toujours disponible */}
              <div style={section}>
                <div style={label}>Affichage</div>
                <button onClick={() => { fullscreen ? exitFullscreen() : enterFullscreen(); }} style={{ ...toggleRow(fullscreen), marginBottom: 0 }}>
                  <span>Plein écran immersif</span><span style={pill(fullscreen)}>{fullscreen ? 'ON' : 'OFF'}</span>
                </button>
              </div>

              <div style={{ fontSize: '.75rem', color: 'rgba(255,255,255,.4)', lineHeight: 1.7, marginTop: '.4rem' }}>
                Geste de zoom : <b>{zoomGesture === 'doubletap' ? 'Double-tap' : zoomGesture === 'pinch' ? 'Pincement' : 'Double-tap + pincement'}</b>.
                Choix des options visibles, valeurs et geste dans <b onClick={() => navigate('/settings')} style={{ cursor: 'pointer', textDecoration: 'underline' }}>Réglages</b>.
              </div>
            </div>
          </div>
        </div>
        )
      })()}
    </div>
  )
}
