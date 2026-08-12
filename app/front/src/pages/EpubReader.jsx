import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useContext, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { gsap } from 'gsap'
import { api } from '../api/client'
import { AuthCtx } from '../contexts'
import { loadReaderSettings, BASE_AUTO_SPEED } from '../readerSettings'
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
  // Mode « fit-largeur / mise à l'échelle » = MÉCA DE BASE, toujours active (plus une option).
  const fitWidth = true
  const [zoomPct, setZoomPct] = useState(100)            // échelle courante en % (pincement = libre)
  const [autoScroll, setAutoScroll] = useState(false)    // défilement auto activé pour ce profil
  const [scrollPaused, setScrollPaused] = useState(false) // pause manuelle (bouton play/pause flottant)
  const [speedMult, setSpeedMult] = useState(1)          // multiplicateur de vitesse d'auto-scroll
  const [pauseSec, setPauseSec] = useState(0)            // temps de pause entre planches (s)
  const [panSens, setPanSens] = useState(DEFAULT_SENS)   // sensibilité de déplacement quand on double-tap (loupe)
  const [readFilter, setReadFilter] = useState('none')   // confort : none | sepia | night
  const [brightness, setBrightness] = useState(100)      // luminosité de lecture (%)
  const fitWidthRef = useRef(true)
  const speedMultRef = useRef(speedMult)
  const sensRef = useRef(panSens)
  const baseScaleRef = useRef(100)      // échelle de BASE (chips) — le double-tap y ramène
  const zoomPctRef = useRef(zoomPct)
  const autoPausedRef = useRef(false)   // pause momentanée (toucher l'écran, panneau ouvert)
  const scrollPausedRef = useRef(false) // pause manuelle (play/pause)
  const showMenuRef = useRef(false)     // panneau ⚙️ ouvert → on gèle scroll/molette/tactile du lecteur
  const autoCooldownRef = useRef(0)     // pause de bord de planche (survit au redémarrage d'effet)
  const autoAdvancePendingRef = useRef(false)  // en pause "fin de planche", avant d'avancer
  const autoStartPauseRef = useRef(false)      // pause de DÉBUT à armer quand la planche devient visible
  const autoScrollRef = useRef(false)          // lecture de autoScroll sans re-déclencher les effets
  const wheelPauseTimer = useRef()
  useEffect(() => { speedMultRef.current = speedMult }, [speedMult])
  useEffect(() => { sensRef.current = panSens }, [panSens])
  useEffect(() => { zoomPctRef.current = zoomPct }, [zoomPct])
  useEffect(() => { autoScrollRef.current = autoScroll }, [autoScroll])
  useEffect(() => { scrollPausedRef.current = scrollPaused }, [scrollPaused])

  // Profils de lecture (synchronisés par compte). Le profil ACTIF (résolu par manga) pilote
  // quelles options sont visibles + leurs valeurs → on en dérive l'objet `settings` que le
  // reste du reader consomme déjà (boutons visibles, plages, pause auto-scroll).
  const [profStore, setProfStore] = useState(null)
  const [activeProfileId, setActiveProfileId] = useState('default')
  const [showReaderMenu, setShowReaderMenu] = useState(false)
  const [sheetExpanded, setSheetExpanded] = useState(false)   // bottom-sheet plié (55vh) ⇄ étendu (92vh)
  // Dock flottant (play/pause + vitesse + échelle + plein écran) : déplaçable, masquable sur le côté.
  const [dockPos, setDockPos] = useState(() => { try { return JSON.parse(localStorage.getItem('reader_dock_pos')) } catch { return null } })
  const [dockHidden, setDockHidden] = useState(() => localStorage.getItem('reader_dock_hidden') === '1')
  const dockRef = useRef(null)
  const dockDragRef = useRef(null)
  useEffect(() => {
    let alive = true
    loadProfiles(uid).then((st) => {
      if (!alive) return
      setProfStore(st); setActiveProfileId(resolveProfileId(st, mangaId))
    })
    return () => { alive = false }
  }, [uid, mangaId])
  const profile = useMemo(() => (profStore ? getProfile(profStore, activeProfileId) : null), [profStore, activeProfileId])
  const settings = useMemo(() => {
    if (!profile) return loadReaderSettings(uid)
    return {
      buttons: { ...profile.visible, fullscreen: true },
      scaleLevels: profile.values.scaleLevels || [],
      speedMults: profile.values.speedMults || [],
      pauseLevels: profile.values.pauseLevels || [],
      sensLevels: profile.values.sensLevels || [],
      autoEdgePause: profile.state?.pause || 0,
    }
  }, [profile, uid])
  // Change de profil POUR LA SESSION en cours seulement : on N'ÉCRIT PAS `perManga` → ça n'impacte
  // pas le profil assigné au manga via la cover. (L'assignation persistante se fait dans la cover.)
  // On NE ferme PAS le panneau : les commandes du profil sont dedans (comme NeoReader).
  const selectProfile = (id) => { setActiveProfileId(id) }
  const autoEdgePauseRef = useRef(settings.autoEdgePause)
  useEffect(() => { autoEdgePauseRef.current = settings.autoEdgePause }, [settings])
  const scrollRef = useRef()        // conteneur scrollable (mode fit largeur)
  const fitScrollRef = useRef(0)    // position de scroll voulue après changement de page
  const imgReadyRef = useRef(false)
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
    setAutoScroll(!!st.autoscroll)
    setScrollPaused(!!st.autoscroll)   // si l'auto-scroll est actif, on ouvre le chapitre EN PAUSE
    const baseScale = st.scale >= 40 ? st.scale : 100
    baseScaleRef.current = baseScale
    setZoomPct(baseScale)
    setZoom(1); setPan({ x: 0, y: 0 })
    setSpeedMult(st.speedMult > 0 ? st.speedMult : 1)
    setPauseSec(st.pause >= 0 ? st.pause : 0)
    setPanSens(st.sens > 0 ? st.sens : DEFAULT_SENS)
    setReadFilter(st.filter || 'none')
    setBrightness(st.brightness >= 40 && st.brightness <= 100 ? st.brightness : 100)
    appliedProfRef.current = activeProfileId
  }, [profile, activeProfileId])

  const toggleAutoScroll = () => setAutoScroll((v) => { patchActiveState({ autoscroll: !v }); if (v) setScrollPaused(false); return !v })
  // Échelle de BASE : les chips la posent (persistée). Le pincement zoome LIBREMENT par-dessus
  // (transitoire) ; le double-tap ramène à cette base. Poser une base annule la loupe/pincement.
  const setScaleValue = (val) => { baseScaleRef.current = val; setZoomPct(val); setZoom(1); setPan({ x: 0, y: 0 }); patchActiveState({ scale: val }) }
  const cycleScale = () => {
    const levels = settings.scaleLevels.length ? settings.scaleLevels : [100]
    const i = levels.indexOf(baseScaleRef.current)
    setScaleValue(levels[(i + 1) % levels.length])
  }
  // Vitesse d'auto-scroll : multiplicateur (× BASE). Chips + cycle.
  const setSpeedMultValue = (val) => { setSpeedMult(val); patchActiveState({ speedMult: val }) }
  const cycleSpeedMult = () => {
    const mults = settings.speedMults.length ? settings.speedMults : [1]
    const i = mults.findIndex((m) => Math.abs(m - speedMult) < 0.001)
    setSpeedMultValue(mults[(i + 1) % mults.length])
  }
  // Temps de pause entre planches (comme une option du profil).
  const setPauseValue = (val) => { setPauseSec(val); autoEdgePauseRef.current = val; patchActiveState({ pause: val }) }
  // Sensibilité de déplacement quand on a double-tapé (loupe).
  const setSensValue = (val) => { setPanSens(val); patchActiveState({ sens: val }) }
  // Confort de lecture : filtre (sépia/nuit) + luminosité, appliqués en CSS sur la planche.
  const setFilterValue = (val) => { setReadFilter(val); patchActiveState({ filter: val }) }
  const setBrightnessValue = (val) => { setBrightness(val); patchActiveState({ brightness: val }) }
  // ── Dock flottant : déplacement + aimantation au bord (façon bulle utilitaire d'OS mobile) ──
  const onDockDown = (e) => {
    const el = dockRef.current; if (!el) return
    const r = el.getBoundingClientRect()
    dockDragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height }
    try { el.setPointerCapture(e.pointerId) } catch { /* noop */ }
  }
  const onDockMove = (e) => {
    const d = dockDragRef.current; if (!d) return
    let x = e.clientX - d.dx, y = e.clientY - d.dy
    x = Math.max(6, Math.min(window.innerWidth - d.w - 6, x))
    y = Math.max(6, Math.min(window.innerHeight - d.h - 6, y))
    setDockPos({ x, y })
  }
  const onDockUp = () => {
    const d = dockDragRef.current; if (!d) return
    dockDragRef.current = null
    setDockPos((p) => {
      if (!p) return p
      const x = (p.x + d.w / 2 < window.innerWidth / 2) ? 8 : window.innerWidth - d.w - 8  // aimante au bord le plus proche
      const np = { x, y: p.y }
      localStorage.setItem('reader_dock_pos', JSON.stringify(np))
      return np
    })
  }
  const setDockHiddenP = (v) => { setDockHidden(v); localStorage.setItem('reader_dock_hidden', v ? '1' : '0') }
  const dockOnRight = !dockPos || (dockPos.x + 30 > window.innerWidth / 2)   // côté d'aimantation (pour l'onglet masqué)
  const cssReadFilter = (() => {
    const b = (brightness || 100) / 100
    if (readFilter === 'sepia') return `sepia(.55) saturate(.9) brightness(${b})`
    if (readFilter === 'night') return `sepia(.35) hue-rotate(-8deg) contrast(.95) brightness(${b * 0.9})`
    return b !== 1 ? `brightness(${b})` : 'none'
  })()
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
  const pinchRef = useRef(null)             // pincement 2 doigts en cours : { d0, base, z }

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

  // Double-tap : loupe rapide ×ZOOM_LEVEL au point touché. Si on est DÉJÀ zoomé (loupe) OU si le
  // pincement a changé l'échelle par rapport à la BASE → le double-tap RAMÈNE à l'échelle de base.
  const doubleTapZoom = (clientX, clientY) => {
    if (zoom > 1 || Math.abs(zoomPctRef.current - baseScaleRef.current) > 0.5) {
      setZoom(1); setPan({ x: 0, y: 0 }); setZoomPct(baseScaleRef.current); return
    }
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
    // Mode fit-largeur (toujours actif) : on repositionne le scroll (haut pour suivant,
    // bas pour précédent — le bas est appliqué à la fin du chargement de l'image).
    if (scrollRef.current) {
      if (dir === -1 && current > 0) { fitScrollRef.current = 'bottom' }  // page précédente → bas
      else { scrollRef.current.scrollTop = 0; fitScrollRef.current = 0 }  // sinon → haut
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
    if (e.ctrlKey) return          // pincement trackpad : géré par le listener natif (zoom échelle)
    if (showMenuRef.current) return // panneau ⚙️ ouvert : le lecteur ne défile pas
    if (zoomed) return
    if (fitWidth) {
      // molette manuelle → pause l'auto-scroll un instant, puis reprise
      autoPausedRef.current = true
      clearTimeout(wheelPauseTimer.current)
      wheelPauseTimer.current = setTimeout(() => { autoPausedRef.current = false }, 700)
      // Défilement natif dans la planche ; on ne change de page qu'en début/fin de planche,
      // et seulement si le mode molette est actif (cohabitation des deux mécaniques).
      if (!scrollNav) return
      if (zoomPctRef.current > 100) return   // planche agrandie (>100 %) → molette = scroll libre, pas de nav
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

  // ── Gestes tactiles (mode fit-largeur, toujours actif) ──
  // • 2 doigts = PINCEMENT → zoom LIBRE de l'échelle (transitoire, ne touche pas la base).
  // • double-tap = loupe rapide + pan à la sensibilité ; re-double-tap = retour à l'échelle de base.
  // • 1 doigt sinon = scroll natif + swipe pour changer de planche (si molette active).
  const onTouchStart = useCallback((e) => {
    if (showMenuRef.current) return
    const t = e.touches[0]
    touchStartRef.current = { x: t.clientX, y: t.clientY }
    touchMovedRef.current = false
    autoPausedRef.current = true   // toucher l'écran → pause l'auto-scroll
    if (e.touches.length === 2) {
      const a = e.touches[0], b = e.touches[1]
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      pinchRef.current = { d0: d || 1, base: zoomPctRef.current, z: zoomPctRef.current }
      return
    }
    if (zoomed) panStartRef.current = { px: pan.x, py: pan.y, tx: t.clientX, ty: t.clientY }
  }, [zoomed, pan])

  const onTouchMove = useCallback((e) => {
    if (showMenuRef.current) return
    if (pinchRef.current && e.touches.length === 2) {
      const a = e.touches[0], b = e.touches[1]
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      let z = Math.round(pinchRef.current.base * (d / pinchRef.current.d0))
      z = Math.max(40, Math.min(500, z))   // zoom libre 40 %..500 %
      pinchRef.current.z = z
      setZoomPct(z)
      return
    }
    // Déplacement de la loupe (double-tap) : pan à la sensibilité réglable.
    if (zoomed && panStartRef.current) {
      const t = e.touches[0]
      const dx = t.clientX - panStartRef.current.tx
      const dy = t.clientY - panStartRef.current.ty
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) touchMovedRef.current = true
      const s = sensRef.current
      setPan({ x: panStartRef.current.px + dx * s, y: panStartRef.current.py + dy * s })
    }
  }, [zoomed])

  const onTouchEnd = useCallback((e) => {
    if (showMenuRef.current) return
    const t = e.changedTouches[0]
    const now = Date.now()
    // reprise de l'auto-scroll après un court délai (laisse retomber l'inertie iOS)
    clearTimeout(wheelPauseTimer.current)
    wheelPauseTimer.current = setTimeout(() => { autoPausedRef.current = false }, 350)
    // Fin d'un pincement → on garde l'échelle atteinte (transitoire, non persistée : la BASE reste).
    if (pinchRef.current) { pinchRef.current = null; return }
    // Fin d'un pan de loupe → pas un tap.
    if (zoomed && touchMovedRef.current) { panStartRef.current = null; return }

    const dx = t.clientX - touchStartRef.current.x
    const dy = t.clientY - touchStartRef.current.y
    const moved = Math.abs(dx) > 12 || Math.abs(dy) > 12

    // Détection du double-tap (loupe / reset base) — n'importe où.
    if (!moved) {
      const last = lastTapRef.current
      const isDouble = (now - last.t < 300) && Math.abs(t.clientX - last.x) < 45 && Math.abs(t.clientY - last.y) < 45
      if (isDouble) { lastTapRef.current = { t: 0, x: 0, y: 0 }; doubleTapZoom(t.clientX, t.clientY); return }
      lastTapRef.current = { t: now, x: t.clientX, y: t.clientY }
    }
    if (zoomed) return   // zoomé : le tap simple ne navigue pas
    if (zoomPctRef.current > 100) return   // planche agrandie (>100 %) → pas de changement de page

    // Swipe vertical → changer de planche (aux extrémités / si la planche tient), molette active.
    if (!scrollNav) return
    if (!imgReadyRef.current) return
    const el = scrollRef.current
    if (!el) return
    if (Math.abs(dy) < 40) return   // tap → onAreaClick
    const fits = el.scrollHeight <= el.clientHeight + 3
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 3
    const atTop = el.scrollTop <= 3
    if (dy < 0 && (fits || atBottom)) goNext()        // swipe vers le haut → suivant
    else if (dy > 0 && (fits || atTop)) goPrev()      // swipe vers le bas → précédent
  }, [scrollNav, zoomed, goNext, goPrev]) // eslint-disable-line

  // Clic latéral = changement de page
  const onAreaClick = useCallback((e) => {
    if (zoomed || showMenuRef.current) return
    if (zoomPctRef.current > 100) return   // planche agrandie (>100 %) → pas de changement de page
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
    if (IS_TOUCH) return
    doubleTapZoom(e.clientX, e.clientY)
  }, [zoomed]) // eslint-disable-line

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
      if (el && !autoPausedRef.current && !scrollPausedRef.current && imgReadyRef.current && now > autoCooldownRef.current) {
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
          acc += BASE_AUTO_SPEED * (speedMultRef.current || 1) * dt
          const px = Math.floor(acc)
          if (px > 0) { el.scrollTop += Math.min(px, remaining); acc -= px }
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [autoScroll, fitWidth, current, images.length, nextChapNum, goNext])

  // Panneau ⚙️ ouvert → auto-scroll en pause ET plus aucun scroll/molette/tactile du lecteur.
  useEffect(() => {
    showMenuRef.current = showReaderMenu
    if (showReaderMenu) { autoPausedRef.current = true; return }
    const t = setTimeout(() => { autoPausedRef.current = false }, 250)
    return () => clearTimeout(t)
  }, [showReaderMenu])

  // Pincement TRACKPAD (ctrl+molette) → zoom de l'ÉCHELLE (pas le zoom du navigateur). Listener
  // natif non-passif pour pouvoir preventDefault. Sépare clairement pincement et molette.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheelNative = (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const z = Math.max(40, Math.min(500, Math.round(zoomPctRef.current * (1 - e.deltaY * 0.01))))
      setZoomPct(z)
    }
    el.addEventListener('wheel', onWheelNative, { passive: false })
    return () => el.removeEventListener('wheel', onWheelNative)
  }, [])

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
        {settings.buttons.restart && loaded && images.length > 0 && current > 0 && (
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
        {settings.buttons.chapnav && <div style={{ display: 'flex', gap: '.3rem' }}>
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
        </div>}
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
          filter: cssReadFilter,   // confort de lecture (sépia/nuit + luminosité)
          ...(fitWidth
            ? (zoomed
              ? {
                // Loupe (double-tap) active : on gère nous-mêmes le pan, pas de scroll natif.
                overflow: 'hidden', alignItems: 'center', touchAction: 'none',
              }
              : {
                // Mise à l'échelle : image ajustée à la largeur (× zoomPct), scroll vertical natif
                // (+ horizontal si la planche est agrandie au-delà de 100 %).
                overflowY: 'auto', overflowX: zoomPct > 100 ? 'auto' : 'hidden',
                overscrollBehavior: 'contain',   // pas de rebond/chaînage : sensation "appli", pas "bas de site"
                alignItems: 'flex-start',
                touchAction: zoomPct > 100 ? 'pan-x pan-y' : 'pan-y',
              })
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
                style={{
                  width: `${zoomPct}%`, height: 'auto', display: 'block', userSelect: 'none',
                  margin: 'auto 0', flexShrink: 0,   // centré verticalement quand la planche tient (plein écran inclus)
                  ...(zoomed ? {
                    transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                    transformOrigin: `${origin.x}px ${origin.y}px`,
                    transition: 'none', willChange: 'transform', cursor: 'grab',
                  } : null),
                }}
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

      {/* Dock flottant : play/pause + vitesse + échelle + plein écran. Déplaçable (poignée),
          aimanté au bord au relâchement, masquable en onglet sur le côté (façon bulle d'OS). */}
      {autoScroll && settings.buttons.autoscroll && (
        dockHidden ? (
          <button onClick={() => setDockHiddenP(false)} title="Afficher les contrôles"
            style={{ position: 'fixed', zIndex: 61, [dockOnRight ? 'right' : 'left']: 0,
              top: dockPos ? dockPos.y : undefined, bottom: dockPos ? undefined : (fullscreen ? 40 : 76),
              width: 26, height: 46, border: 'none', cursor: 'pointer', color: '#fff',
              background: 'rgba(20,20,24,.92)', boxShadow: '0 2px 12px rgba(0,0,0,.5)',
              borderRadius: dockOnRight ? '12px 0 0 12px' : '0 12px 12px 0',
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {dockOnRight ? <polyline points="15 18 9 12 15 6"/> : <polyline points="9 18 15 12 9 6"/>}
            </svg>
          </button>
        ) : (
          <div ref={dockRef}
            style={{ position: 'fixed', zIndex: 61,
              ...(dockPos ? { left: dockPos.x, top: dockPos.y } : { right: 10, bottom: fullscreen ? 18 : 54 }),
              width: 96, background: 'rgba(20,20,24,.94)', border: '1px solid rgba(255,255,255,.12)',
              borderRadius: 16, boxShadow: '0 4px 22px rgba(0,0,0,.55)', padding: 6, touchAction: 'none' }}>
            {/* Poignée de déplacement + bouton masquer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5, cursor: 'grab' }}
              onPointerDown={onDockDown} onPointerMove={onDockMove} onPointerUp={onDockUp}>
              <span style={{ display: 'flex', gap: 2, paddingLeft: 4 }}>
                {[0, 1, 2].map((i) => <span key={i} style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(255,255,255,.4)' }} />)}
              </span>
              <button onClick={() => setDockHiddenP(true)} title="Masquer sur le côté"
                style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.55)', cursor: 'pointer', padding: '0 2px', fontSize: '.9rem', lineHeight: 1 }}>⤫</button>
            </div>
            {/* Grille 2×2 de contrôles */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
              <button onClick={() => setScrollPaused((v) => !v)} title={scrollPaused ? 'Reprendre' : 'Pause'}
                style={{ height: 36, borderRadius: 10, border: 'none', cursor: 'pointer', background: '#e50914', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {scrollPaused
                  ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>}
              </button>
              <button onClick={cycleSpeedMult} title="Vitesse (re-cliquer pour changer)"
                style={{ height: 36, borderRadius: 10, border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,.1)', color: '#fff', fontWeight: 800, fontSize: '.8rem' }}>×{speedMult}</button>
              <button onClick={cycleScale} title="Taille de planche (re-cliquer pour changer)"
                style={{ height: 36, borderRadius: 10, border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,.1)', color: zoomPct === baseScaleRef.current ? '#fff' : '#e50914', fontWeight: 800, fontSize: '.8rem' }}>{baseScaleRef.current}%</button>
              <button onClick={() => { fullscreen ? exitFullscreen() : enterFullscreen() }} title="Plein écran"
                style={{ height: 36, borderRadius: 10, border: 'none', cursor: 'pointer', background: fullscreen ? '#e50914' : 'rgba(255,255,255,.1)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>
                </svg>
              </button>
            </div>
          </div>
        )
      )}

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
              <button onClick={() => setShowReaderMenu(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.6)', fontSize: '1.2rem', cursor: 'pointer', padding: '0 .2rem' }}>✕</button>
            </div>

            <div style={{ overflowY: 'auto', overscrollBehavior: 'contain', flex: 1, minHeight: 0, paddingRight: '.2rem' }}>
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

              {/* Plein écran immersif — EN PREMIER */}
              <button onClick={() => { fullscreen ? exitFullscreen() : enterFullscreen() }} style={toggleRow(fullscreen)}>
                <span>Plein écran immersif</span><span style={pill(fullscreen)}>{fullscreen ? 'ON' : 'OFF'}</span>
              </button>

              {/* Échelle — MÉCA DE BASE : le % change (le pincement zoome librement au-delà) */}
              <div style={section}>
                <div style={label}>Taille de planche (pincer pour zoomer librement)</div>
                <div style={chipRow}>
                  {settings.scaleLevels.map((v) => (
                    <button key={v} onClick={() => setScaleValue(v)} style={chip(zoomPct === v)}>{v}%</button>
                  ))}
                  {!settings.scaleLevels.includes(zoomPct) && (
                    <span style={{ ...chip(true), cursor: 'default' }}>{zoomPct}%</span>
                  )}
                </div>
              </div>

              {/* Défilement automatique + multiplicateur de vitesse + temps de pause */}
              {vis.autoscroll && (
                <button onClick={toggleAutoScroll} style={toggleRow(autoScroll)}>
                  <span>Défilement automatique</span><span style={pill(autoScroll)}>{autoScroll ? 'ON' : 'OFF'}</span>
                </button>
              )}
              {vis.autoscroll && (
                <div style={section}>
                  <div style={label}>Vitesse (× multiplicateur)</div>
                  <div style={chipRow}>
                    {settings.speedMults.map((m) => (
                      <button key={m} onClick={() => setSpeedMultValue(m)} style={chip(Math.abs(speedMult - m) < 0.001)}>×{m}</button>
                    ))}
                  </div>
                </div>
              )}
              {vis.autoscroll && (
                <div style={section}>
                  <div style={label}>Temps de pause entre planches</div>
                  <div style={chipRow}>
                    {settings.pauseLevels.map((s) => (
                      <button key={s} onClick={() => setPauseValue(s)} style={chip(Math.abs(pauseSec - s) < 0.001)}>{s === 0 ? 'Aucune' : `${s}s`}</button>
                    ))}
                  </div>
                </div>
              )}

              {/* Sensibilité de déplacement (loupe après double-tap) */}
              {vis.sensitivity && (
                <div style={section}>
                  <div style={label}>Sensibilité de déplacement (double-tap)</div>
                  <div style={chipRow}>
                    {settings.sensLevels.map((v) => (
                      <button key={v} onClick={() => setSensValue(v)} style={chip(Math.abs(panSens - v) < 0.001)}>×{v}</button>
                    ))}
                  </div>
                </div>
              )}

              {/* Confort de lecture : filtre + luminosité */}
              <div style={section}>
                <div style={label}>Confort (filtre)</div>
                <div style={chipRow}>
                  {[['none', 'Aucun'], ['sepia', 'Sépia'], ['night', 'Nuit']].map(([v, lbl]) => (
                    <button key={v} onClick={() => setFilterValue(v)} style={chip(readFilter === v)}>{lbl}</button>
                  ))}
                </div>
              </div>
              <div style={section}>
                <div style={label}>Luminosité</div>
                <div style={chipRow}>
                  {[100, 85, 70, 55, 40].map((v) => (
                    <button key={v} onClick={() => setBrightnessValue(v)} style={chip(brightness === v)}>{v}%</button>
                  ))}
                </div>
              </div>

              {/* Navigation molette / liseuse */}
              {vis.scrollnav && (
                <button onClick={toggleScrollNav} style={toggleRow(scrollNav)}>
                  <span>Navigation à la molette / liseuse</span><span style={pill(scrollNav)}>{scrollNav ? 'ON' : 'OFF'}</span>
                </button>
              )}

              <div style={{ fontSize: '.75rem', color: 'rgba(255,255,255,.4)', lineHeight: 1.7, marginTop: '.4rem' }}>
                Options visibles et valeurs proposées : <b onClick={() => navigate('/settings')} style={{ cursor: 'pointer', textDecoration: 'underline' }}>Réglages</b>.
              </div>
            </div>
          </div>
        </div>
        )
      })()}
    </div>
  )
}
