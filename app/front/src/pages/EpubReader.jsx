import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useContext, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { gsap } from 'gsap'
import { api } from '../api/client'
import { AuthCtx, CastCtx } from '../contexts'
import { loadReaderSettings, BASE_AUTO_SPEED, CINE_DWELL_CHOICES } from '../readerSettings'
import { loadProfiles, resolveProfileId, getProfile, saveProfiles } from '../readerProfiles'
import { detectPanels } from '../panelDetect'
import jsQR from 'jsqr'   // repli scanner QR quand BarcodeDetector est absent (iOS/anciens navigateurs)
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

// Logo « clap de cinéma » en trait blanc (currentColor) — remplace l'emoji 🎬 qui rendait en couleur.
function ClapIcon({ size = 16, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
      <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/>
      <path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/>
      <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>
    </svg>
  )
}

function CastIcon({ size = 16, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
      <path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/>
      <line x1="2" y1="20" x2="2.01" y2="20"/>
    </svg>
  )
}

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
  // Paysage : on affiche la planche ENTIÈRE (échelle appliquée sur la HAUTEUR) ; buffer par orientation.
  const [isLandscape, setIsLandscape] = useState(() => typeof window !== 'undefined' && window.innerWidth > window.innerHeight)
  const profStateRef = useRef(null)
  const landRef = useRef(typeof window !== 'undefined' && window.innerWidth > window.innerHeight)
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
  const [dockShow, setDockShow] = useState(() => localStorage.getItem('reader_dock_show') !== '0')   // afficher le dock flottant (défaut ON)
  const [dockKind, setDockKind] = useState(() => localStorage.getItem('reader_dock_kind') || 'classic')  // 'classic' (auto-scroll) | 'cinema'
  const dockRef = useRef(null)
  const dockDragRef = useRef(null)
  // ── Cast « second écran » (TV) : session au niveau App (survit à la navigation) ──
  const cast = useContext(CastCtx)
  const casting = cast.casting
  const [castOpen, setCastOpen] = useState(false)     // modale de saisie du code
  const [castCode, setCastCode] = useState('')        // code tapé
  const [remoteMode, setRemoteMode] = useState('normal')  // layout télécommande : 'normal' | 'cine' (indépendant du flag cinema)
  // Télécommande — mode « souris » (trackpad) + auto-scroll (mode normal), pilotant la TV.
  const [castMouse, setCastMouse] = useState(false)
  const [castZoom, setCastZoom] = useState(1)             // zoom page envoyé à la TV (normale)
  const [castPan, setCastPan] = useState({ x: 0, y: 0 })  // recentrage normalisé (-0.5..0.5)
  const [castAutoscroll, setCastAutoscroll] = useState(false)
  const castZoomRef = useRef(1)
  const padDragRef = useRef(null)
  const lastPadTapRef = useRef(0)
  const goToLastPanelRef = useRef(false)   // cinéma : « case précédente » a franchi une planche → viser la dernière case
  // Scanner QR intégré (PWA en HTTPS) : ouvre la caméra pour lire le QR de la TV.
  const [scanning, setScanning] = useState(false)
  const [scanErr, setScanErr] = useState('')
  const scanVideoRef = useRef(null)
  const scanStreamRef = useRef(null)
  // Mode Cinéma (bêta) : détection des cases + caméra qui glisse de case en case (sens manga).
  const [cinema, setCinema] = useState(() => localStorage.getItem('reader_cinema') === '1')
  const [panels, setPanels] = useState([])
  const [panelIdx, setPanelIdx] = useState(0)
  const [camXform, setCamXform] = useState('none')
  const [fitXform, setFitXform] = useState('none')      // transform "planche entière" (vue debug)
  const [panelDebug, setPanelDebug] = useState(false)   // vue debug : dessine les cases détectées + ordre
  const [detecting, setDetecting] = useState(false)     // découpage en cours → on montre la planche entière
  // Mise à l'échelle UTILISATEUR en cinéma : PERSISTE d'une case/planche/session à l'autre.
  const [cinemaZoom, setCinemaZoomState] = useState(() => { const v = Number(localStorage.getItem('reader_cinema_zoom')); return v >= 0.4 && v <= 5 ? v : 1 })
  const setCinemaZoom = (z) => { const v = Math.max(0.4, Math.min(5, z)); localStorage.setItem('reader_cinema_zoom', String(v)); setCinemaZoomState(v) }
  const [cinemaPan, setCinemaPan] = useState({ x: 0, y: 0 })
  const [cinInteract, setCinInteract] = useState(false) // pincement/glissement en cours → transition off
  const [camTransition, setCamTransition] = useState('transform .5s cubic-bezier(.4,0,.2,1)')  // transition caméra (auto-pan long = durée du dwell)
  const [resizeTick, setResizeTick] = useState(0)       // bump → force le recalcul caméra (rotation/resize)
  const camRafRef = useRef(0)
  // Déplacement caméra FIABLE : on pose la transition, puis on change le transform à la frame
  // SUIVANTE. Sinon, changer transition+transform d'un coup depuis 'none' (après un auto-pan ou
  // un geste) fait SAUTER l'animation par intermittence (le smooth du cinéma « disparaît »).
  const applyCam = (transition, xform) => {
    cancelAnimationFrame(camRafRef.current)
    setCamTransition(transition)
    camRafRef.current = requestAnimationFrame(() => setCamXform(xform))
  }
  // Auto-LECTURE cinéma : avance case par case, dwell adapté au TEXTE, auto-pan des longues cases.
  const [cinemaPlaying, setCinemaPlaying] = useState(false)
  const [cineMin, setCineMin] = useState(1.5)      // dwell case sans texte / action (s)
  const [cineNormal, setCineNormal] = useState(2.5) // dwell case normale (peu de texte)
  const [cineMax, setCineMax] = useState(5)        // dwell case bavarde (s)
  const cinemaTimerRef = useRef(null)
  const camBaseRef = useRef(null)                        // { cx, cy, baseK } du cadrage caméra
  const cinPinchRef = useRef(null)
  const cinPanRef = useRef(null)
  const cinemaWrapRef = useRef(null)
  const cinemaImgRef = useRef(null)
  const panelCacheRef = useRef({})   // { "manga:chap:page": panels } — évite de re-détecter
  const detectKeyRef = useRef(null)  // planche en cours de détection (dédoublonnage)
  useEffect(() => {
    let alive = true
    loadProfiles(uid).then((st) => {
      if (!alive) return
      setProfStore(st); setActiveProfileId(resolveProfileId(st, mangaId))
    })
    return () => { alive = false }
  }, [uid, mangaId])
  const profile = useMemo(() => (profStore ? getProfile(profStore, activeProfileId) : null), [profStore, activeProfileId])
  useEffect(() => { profStateRef.current = profile?.state || null }, [profile])
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
  // Visibilité d'options (ex. boutons chapitre / « Début ») directement depuis le reader.
  const patchActiveVisible = (patch) => {
    setProfStore((prev) => {
      if (!prev) return prev
      const id = activeProfileIdRef.current
      const p = prev.profiles[id]; if (!p) return prev
      const next = { ...prev, profiles: { ...prev.profiles, [id]: { ...p, visible: { ...(p.visible || {}), ...patch } } } }
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
    const rawScale = isLandscape ? st.scaleLandscape : st.scale     // buffer par orientation
    const baseScale = rawScale >= 40 ? rawScale : 100
    baseScaleRef.current = baseScale
    setZoomPct(baseScale)
    setZoom(1); setPan({ x: 0, y: 0 })
    setSpeedMult(st.speedMult > 0 ? st.speedMult : 1)
    setPauseSec(st.pause >= 0 ? st.pause : 0)
    setPanSens(st.sens > 0 ? st.sens : DEFAULT_SENS)
    setReadFilter(st.filter || 'none')
    setBrightness(st.brightness >= 40 && st.brightness <= 100 ? st.brightness : 100)
    setCineMin(st.cineMin > 0 ? st.cineMin : 1.5)
    setCineNormal(st.cineNormal > 0 ? st.cineNormal : 2.5)
    setCineMax(st.cineMax > 0 ? st.cineMax : 5)
    appliedProfRef.current = activeProfileId
  }, [profile, activeProfileId])

  // Rotation portrait ⇄ paysage : buffer par orientation — on sauve l'échelle courante dans
  // l'orientation qu'on quitte et on charge celle de la nouvelle (garde-fou paysage = planche entière).
  useEffect(() => {
    const onOri = () => {
      const land = window.innerWidth > window.innerHeight
      if (land === landRef.current) return
      patchActiveState({ [landRef.current ? 'scaleLandscape' : 'scale']: baseScaleRef.current })  // sauve l'ancienne
      landRef.current = land
      const st = profStateRef.current || {}
      const raw = land ? st.scaleLandscape : st.scale
      const next = raw >= 40 ? raw : 100
      baseScaleRef.current = next
      setZoomPct(next); setZoom(1); setPan({ x: 0, y: 0 })
      setIsLandscape(land)
    }
    window.addEventListener('resize', onOri)
    window.addEventListener('orientationchange', onOri)
    return () => { window.removeEventListener('resize', onOri); window.removeEventListener('orientationchange', onOri) }
  }, [])   // eslint-disable-line

  const toggleAutoScroll = () => setAutoScroll((v) => { patchActiveState({ autoscroll: !v }); if (v) setScrollPaused(false); return !v })
  // Échelle de BASE : les chips la posent (persistée). Le pincement zoome LIBREMENT par-dessus
  // (transitoire) ; le double-tap ramène à cette base. Poser une base annule la loupe/pincement.
  const setScaleValue = (val) => {
    if (cinema) { setCinemaZoom(val / 100); return }   // en cinéma, l'échelle pilote le zoom caméra (TA mise à l'échelle)
    baseScaleRef.current = val; setZoomPct(val); setZoom(1); setPan({ x: 0, y: 0 }); patchActiveState({ [isLandscape ? 'scaleLandscape' : 'scale']: val })
  }
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
    // Capture sur l'ÉLÉMENT qui reçoit les events (la poignée) → tous les move/up y arrivent = drag fluide.
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
    e.preventDefault()
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
  const setDockShowP = (v) => { setDockShow(v); localStorage.setItem('reader_dock_show', v ? '1' : '0') }
  const setDockKindP = (v) => { setDockKind(v); localStorage.setItem('reader_dock_kind', v) }
  // ── Cast : la session vit au niveau App (survit à la navigation) ; ici on ne fait que
  //    l'ouvrir/fermer et lui pousser l'état de lecture. La diffusion ne s'arrête donc QUE
  //    sur « Arrêter », pas quand on quitte le lecteur. ──
  const PAD_GAIN = 2.4                                   // sensibilité du trackpad souris
  const resetCastView = () => { setCastMouse(false); setCastZoom(1); setCastPan({ x: 0, y: 0 }); setCastAutoscroll(false) }
  const startCast = (code) => { resetCastView(); cast.start(code); setCastOpen(false) }
  // À l'arrêt de la diffusion : on coupe la connexion ET on réinitialise les modes activés pour
  // la TV (cinéma, auto-lecture, souris, auto-scroll, zoom/pan) → le lecteur mobile repart propre.
  const stopCast = () => {
    cast.stop()
    resetCastView()
    setRemoteMode('normal')
    setCinemaPlaying(false)
    if (cinema) toggleCinema()
  }
  // « Caster sur un appareil » : Chrome découvre les Chromecast/Cast intégré et affiche son
  // sélecteur natif (API Presentation). On ouvre /tv sur la TV choisie avec un code partagé →
  // pairing automatique (le tel crée la salle, la TV présentée la rejoint). Aucun code à taper.
  const castToDevice = () => {
    setScanErr('')
    if (!('PresentationRequest' in window)) {
      const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches
      const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      setScanErr(iOS
        ? 'Le sélecteur Cast n’existe pas sur iOS/iPhone. Utilise le scan du QR ci-dessous.'
        : standalone
          ? 'Indispo dans l’app installée : ouvre-la dans un onglet Chrome pour le sélecteur, ou scanne le QR.'
          : 'Sélecteur non supporté (Chrome requis). Scanne le QR à la place.')
      return
    }
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
    const code = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('')
    try {
      const req = new window.PresentationRequest([`${location.origin}/tv?castcode=${code}`])
      req.start()
        .then(() => { resetCastView(); cast.start(code, { create: true }); setCastOpen(false) })
        .catch((e) => { if (e && e.name !== 'AbortError' && e.name !== 'NotAllowedError') setScanErr('Aucun appareil Cast trouvé sur le réseau.') })
    } catch { setScanErr('Sélecteur d’appareils indisponible.') }
  }
  // ── Scanner QR (caméra) : lit le QR de la TV → extrait le code → lance la diffusion ──
  const stopScan = () => {
    try { scanStreamRef.current?.getTracks().forEach((t) => t.stop()) } catch { /* noop */ }
    scanStreamRef.current = null; setScanning(false)
  }
  const startScan = async () => {
    setScanErr('')
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setScanErr('Ouvre l’app en HTTPS (https://62-238-63-117.nip.io) pour activer la caméra.'); return
    }
    try {
      // Caméra arrière si possible, sinon n'importe laquelle (repli → évite OverconstrainedError).
      try { scanStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } }) }
      catch { scanStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: true }) }
      setScanning(true)
    } catch (e) {
      const n = e && e.name
      setScanErr(n === 'NotAllowedError' ? 'Autorise la caméra dans le navigateur, puis réessaie.'
        : n === 'NotFoundError' ? 'Aucune caméra détectée sur cet appareil.'
        : 'Caméra indisponible sur ce navigateur.')
    }
  }
  useEffect(() => {
    if (!scanning) return
    const v = scanVideoRef.current; if (!v) return
    v.srcObject = scanStreamRef.current; v.play().catch(() => {})
    let alive = true, timer, canvas
    let det = null
    try { if ('BarcodeDetector' in window) det = new window.BarcodeDetector({ formats: ['qr_code'] }) } catch { /* on tombera sur jsQR */ }
    const handle = (raw) => {
      if (!raw) return false
      const m = String(raw).match(/castcode=([A-Za-z0-9]{4})/i)
      const c = m ? m[1].toUpperCase() : (/^[A-Za-z0-9]{4}$/.test(String(raw).trim()) ? String(raw).trim().toUpperCase() : '')
      if (c) { alive = false; stopScan(); startCast(c); return true }
      return false
    }
    const scan = async () => {
      if (!alive) return
      try {
        if (det) {
          const codes = await det.detect(v)
          if (codes && codes[0] && handle(codes[0].rawValue)) return
        } else if (v.videoWidth) {                       // repli jsQR via canvas
          if (!canvas) canvas = document.createElement('canvas')
          canvas.width = v.videoWidth; canvas.height = v.videoHeight
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const r = jsQR(img.data, img.width, img.height)
          if (r && handle(r.data)) return
        }
      } catch { /* frame illisible → on retente */ }
      timer = setTimeout(scan, 250)
    }
    scan()
    return () => { alive = false; clearTimeout(timer) }
  }, [scanning]) // eslint-disable-line
  useEffect(() => () => { try { scanStreamRef.current?.getTracks().forEach((t) => t.stop()) } catch { /* noop */ } }, [])   // coupe la caméra en quittant
  // Bascule de mode télécommande : on (ré)initialise proprement la vue à chaque changement.
  const setRemoteCinema = (on) => { if (cinema !== on) toggleCinema(); resetCastView() }
  // Mode souris : le trackpad déplace/zoome la vue sur la TV (lecture normale).
  const onPadDown = (e) => {
    const now = Date.now()
    if (now - lastPadTapRef.current < 300) {        // double-tap → zoom / dézoom
      setCastZoom((z) => (z > 1 ? 1 : 2.5)); setCastPan({ x: 0, y: 0 }); lastPadTapRef.current = 0; padDragRef.current = null; return
    }
    lastPadTapRef.current = now
    padDragRef.current = { x: e.clientX, y: e.clientY, w: e.currentTarget.clientWidth || 1, h: e.currentTarget.clientHeight || 1 }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
  }
  const onPadMove = (e) => {
    const d = padDragRef.current; if (!d) return
    const dx = (e.clientX - d.x) / d.w, dy = (e.clientY - d.y) / d.h
    d.x = e.clientX; d.y = e.clientY
    const z = castZoomRef.current || 1
    setCastPan((p) => ({                             // déplacer la vue = pan inverse du doigt (gain ↑, atténué par le zoom)
      // Garde-fou : en auto-scroll, la souris ne bouge QUE verticalement (pas de dérive latérale).
      x: castAutoscroll ? 0 : Math.max(-0.5, Math.min(0.5, p.x - dx * PAD_GAIN / z)),
      y: Math.max(-0.5, Math.min(0.5, p.y - dy * PAD_GAIN / z)),
    }))
  }
  const onPadUp = () => { padDragRef.current = null }
  // Pas de case (télécommande cinéma) : case suivante/précédente, déborde sur la page voisine.
  const stepPanel = (dir) => {
    if (dir > 0) goToLastPanelRef.current = false   // on avance → la planche suivante démarre à la 1re case
    const n = (panelIdx || 0) + dir
    if (n < 0) { goToLastPanelRef.current = true; return goPrev() }   // ← revenir à la DERNIÈRE case de la planche précédente
    if (n > panels.length - 1) return goNext()
    setPanelIdx(n)
  }
  // Après un « case précédente » qui a changé de planche : dès que le découpage de la nouvelle
  // planche est STABILISÉ (détection finie, plus le placeholder pleine page), on se place sur la
  // DERNIÈRE case (une seule fois). Effet dédié (robuste aux appels multiples de runDetect).
  useEffect(() => {
    if (!goToLastPanelRef.current || detecting) return
    if (!panels.length) return
    if (panels.length === 1 && panels[0].w >= 0.98 && panels[0].h >= 0.98) return   // encore le placeholder
    setPanelIdx(panels.length - 1)   // on ne libère PAS le flag ici : il tient tant qu'on n'avance pas
  }, [panels, detecting])
  // Diffusion active → tout changement d'état (page, cinéma, case, zoom, confort…) poussé sur la TV.
  useEffect(() => { castZoomRef.current = castZoom }, [castZoom])
  useEffect(() => {
    if (!casting) return
    cast.push({
      mangaId, chapterNum, page: current, cinema,
      panelIdx, playing: cinemaPlaying, scale: cinema ? Math.round(cinemaZoom * 100) : zoomPct,
      panels: cinema ? panels.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })) : null,
      filter: readFilter, brightness, normZoom: castZoom, panX: castPan.x, panY: castPan.y,
      autoscroll: castAutoscroll, speed: speedMult, pause: pauseSec,
    })
  }, [casting, current, chapterNum, mangaId, cinema, panelIdx, cinemaPlaying, cinemaZoom, zoomPct, panels, readFilter, brightness, castZoom, castPan, castAutoscroll, speedMult, pauseSec]) // eslint-disable-line
  // Échelle cinéma (zoom caméra) au cycle, pour le bouton du dock cinéma.
  const cycleCinemaScale = () => {
    const levels = settings.scaleLevels.length ? settings.scaleLevels : [100]
    const cur = Math.round(cinemaZoom * 100)
    const i = levels.findIndex((l) => l === cur)
    setCinemaZoom(levels[(i + 1) % levels.length] / 100)
  }
  // ── Geste « scrub » commun aux boutons « cycle » des docks (échelle, vitesse…) ──
  // Au lieu de re-cliquer/spammer pour retrouver la bonne valeur : on MAINTIENT le bouton
  // et on GLISSE (haut = plus, bas = moins) → ça parcourt les niveaux du profil en direct
  // (façon curseur), on LÂCHE pour se figer dessus. Un simple tap sans glisser garde
  // l'ancien comportement (cycle au niveau suivant).
  const scrubRef = useRef(null)     // { startY, startIdx, levels, apply, moved }
  const SCRUB_STEP = 26             // px de glissement vertical par niveau
  const [scrubbing, setScrubbing] = useState(false)
  const onScrubDown = (e, levels, curLevel, apply) => {
    if (!levels.length) return
    let idx = levels.indexOf(curLevel)
    if (idx < 0)  // valeur libre hors liste (pincement) → on repart du niveau le plus proche
      idx = levels.reduce((b, l, i) => (Math.abs(l - curLevel) < Math.abs(levels[b] - curLevel) ? i : b), 0)
    scrubRef.current = { startY: e.clientY, startIdx: idx, levels, apply, moved: false }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
  }
  const onScrubMove = (e) => {
    const s = scrubRef.current; if (!s) return
    const steps = Math.round((s.startY - e.clientY) / SCRUB_STEP)   // vers le haut = +
    if (steps !== 0 && !s.moved) { s.moved = true; setScrubbing(true) }
    const idx = Math.max(0, Math.min(s.levels.length - 1, s.startIdx + steps))
    s.apply(s.levels[idx])
  }
  const onScrubUp = (e, cycle) => {
    const s = scrubRef.current; scrubRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* noop */ }
    setScrubbing(false)
    if (s && !s.moved) cycle()   // pas de glissement = simple tap = cycle
  }
  // ── Mode Cinéma ──
  const toggleCinema = () => setCinema((v) => { const n = !v; localStorage.setItem('reader_cinema', n ? '1' : '0'); return n })
  // Détection des cases : MODÈLE côté serveur (YOLO manga109) en priorité, repli sur le
  // détecteur heuristique JS si le serveur est indisponible. Cache par planche.
  const runDetect = async () => {
    const im = cinemaImgRef.current
    if (!im || !im.naturalWidth) return
    const key = `${mangaId}:${chapterNum}:${current}`
    const cached = panelCacheRef.current[key]
    if (cached) { setPanels(cached); if (!goToLastPanelRef.current) setPanelIdx(0); return }
    if (detectKeyRef.current === key) return          // déjà en cours (évite onLoad + effet en double)
    detectKeyRef.current = key
    // Pendant la détection : on montre la planche ENTIÈRE (jamais un mauvais découpage) + indicateur.
    setPanels([{ x: 0, y: 0, w: 1, h: 1 }]); setPanelIdx(0); setDetecting(true)
    let ps = null
    try {
      const W = Math.min(860, im.naturalWidth), sc = W / im.naturalWidth, H = Math.round(im.naturalHeight * sc)
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H
      cv.getContext('2d').drawImage(im, 0, 0, W, H)
      const url = cv.toDataURL('image/jpeg', 0.85)
      const ask = async () => { try { const r = await api.detectPanels(url); return (r && Array.isArray(r.panels) && r.panels.length) ? r.panels : null } catch { return null } }
      ps = await ask() || await ask()   // 1 retry : le worker unique peut être occupé (prefetch) → évite le repli JS trop faible
    } catch { /* serveur KO → repli */ }
    if (!ps) ps = detectPanels(im)                       // repli heuristique client
    // « Planche entière » = pas de vrai découpage (serveur occupé/injoignable + repli JS vide,
    // ou modèle qui a tout fusionné). On l'AFFICHE mais on NE la met PAS en cache → la prochaine
    // visite retente le serveur, au lieu de resservir un placeholder collé (le « n1 » remonté).
    const fellBack = !ps || !ps.length || (ps.length === 1 && ps[0].w >= 0.98 && ps[0].h >= 0.98)
    if (fellBack) ps = [{ x: 0, y: 0, w: 1, h: 1 }]
    if (!fellBack) panelCacheRef.current[key] = ps
    if (detectKeyRef.current === key) detectKeyRef.current = null
    setDetecting(false)
    setPanels(ps); if (!goToLastPanelRef.current) setPanelIdx(0)
    prefetchDetect(current + 1)   // prépare la suivante en fond → navigation instantanée
  }
  // Détecte une planche EN FOND (sans toucher l'affichage) → mise en cache pour l'avance instantanée.
  const prefetchDetect = (idx) => {
    if (idx < 0 || idx >= images.length) return
    const key = `${mangaId}:${chapterNum}:${idx}`
    if (panelCacheRef.current[key]) return
    const im = new Image()
    im.onload = async () => {
      try {
        const W = Math.min(860, im.naturalWidth), sc = W / im.naturalWidth, H = Math.round(im.naturalHeight * sc)
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H
        cv.getContext('2d').drawImage(im, 0, 0, W, H)
        const r = await api.detectPanels(cv.toDataURL('image/jpeg', 0.85))
        const ps = r && Array.isArray(r.panels) ? r.panels : []
        const wholePage = ps.length === 1 && ps[0].w >= 0.98 && ps[0].h >= 0.98
        if (ps.length && !wholePage && !panelCacheRef.current[key]) panelCacheRef.current[key] = ps
      } catch { /* silencieux */ }
    }
    im.src = images[idx]
  }
  // Nouvelle planche → 1re case. En cinéma, on repasse AUSSITÔT en « découpage » (planche entière)
  // tant que la détection de CETTE planche n'est pas revenue → l'auto-lecture ne démarre JAMAIS
  // avant le découpage (le trou : `detecting` gardait encore la valeur de la planche précédente
  // jusqu'au onLoad, laissant l'auto-lecture partir sur des cases périmées, surtout à grosse échelle).
  useEffect(() => {
    if (!goToLastPanelRef.current) setPanelIdx(0)    // sauf si on vise la DERNIÈRE case (retour planche précédente)
    if (!cinema) return
    const key = `${mangaId}:${chapterNum}:${current}`
    if (panelCacheRef.current[key]) return          // déjà détecté (prefetch) → pas d'attente
    setDetecting(true); setPanels([{ x: 0, y: 0, w: 1, h: 1 }])
  }, [current, chapterNum, cinema]) // eslint-disable-line
  useEffect(() => {   // image déjà en cache → onLoad ne se déclenche pas : on détecte quand même
    if (!cinema) return
    const im = cinemaImgRef.current
    if (im && im.complete && im.naturalWidth) runDetect()
  }, [cinema, current, chapterNum]) // eslint-disable-line
  // Calcule la transformation caméra pour cadrer la case courante (zoom + recentrage, easé en CSS).
  useLayoutEffect(() => {
    if (!cinema) return
    const wrap = cinemaWrapRef.current, im = cinemaImgRef.current
    if (!wrap || !im || !im.naturalWidth || !panels.length) return
    const CW = wrap.clientWidth, CH = wrap.clientHeight
    const dispW = CW, dispH = CW * (im.naturalHeight / im.naturalWidth)
    const p = panels[Math.min(panelIdx, panels.length - 1)] || { x: 0, y: 0, w: 1, h: 1 }
    const pw = p.w * dispW, ph = p.h * dispH
    const cx = (p.x + p.w / 2) * dispW, cy = (p.y + p.h / 2) * dispH
    const baseK = Math.min((CW / pw) * 0.96, (CH / ph) * 0.96)   // cadre la case ENTIÈREMENT (contain, portrait/paysage)
    camBaseRef.current = { cx, cy, baseK }
    // Transform "planche ENTIÈRE" : contain de toute l'image, centrée (vue debug ET pendant la détection)
    const kAll = Math.min(1, CW / dispW, CH / dispH)
    setFitXform(`translate(${(CW - kAll * dispW) / 2}px, ${(CH - kAll * dispH) / 2}px) scale(${kAll})`)
    if (detecting) {   // découpage pas prêt → on montre la planche ENTIÈRE (pas de cadrage/lecture prématurés)
      setCamTransition('transform .3s ease'); setCamXform(`translate(${(CW - kAll * dispW) / 2}px, ${(CH - kAll * dispH) / 2}px) scale(${kAll})`)
      return
    }
    if (cinemaPlaying) return                                                 // l'auto-lecture pilote la caméra
    const k = baseK * cinemaZoom                                              // + mise à l'échelle UTILISATEUR
    const xf = `translate(${CW / 2 - k * cx + cinemaPan.x}px, ${CH / 2 - k * cy + cinemaPan.y}px) scale(${k})`
    if (cinInteract) { setCamTransition('none'); setCamXform(xf) }            // geste direct → suivi immédiat
    else applyCam('transform .5s cubic-bezier(.4,0,.2,1)', xf)               // sinon transition fiable (jamais sautée)
  }, [cinema, panels, panelIdx, current, fullscreen, cinemaZoom, cinemaPan, isLandscape, cinemaPlaying, cinInteract, detecting, resizeTick]) // eslint-disable-line
  useEffect(() => { setCinemaPan({ x: 0, y: 0 }) }, [panelIdx, current, chapterNum])  // reset PAN seulement (le zoom persiste)
  useEffect(() => {
    if (!cinema) return
    // Recalcul FIABLE de la caméra après resize/rotation : on bump un tick (à la frame suivante
    // ET ~300 ms après, le temps que les dimensions se stabilisent post-rotation). L'ancien
    // setPanelIdx(i=>i) était un no-op (React bail-out) → la caméra restait figée après bascule.
    const bump = () => { requestAnimationFrame(() => setResizeTick((t) => t + 1)); setTimeout(() => setResizeTick((t) => t + 1), 300) }
    window.addEventListener('resize', bump)
    window.addEventListener('orientationchange', bump)
    return () => { window.removeEventListener('resize', bump); window.removeEventListener('orientationchange', bump) }
  }, [cinema])

  // ── AUTO-LECTURE cinéma : avance case par case, dwell = f(texte), auto-pan des longues cases ──
  useEffect(() => {
    clearTimeout(cinemaTimerRef.current)
    if (!cinema || !cinemaPlaying || detecting || !panels.length) return
    cancelAnimationFrame(camRafRef.current)   // (lecture auto uniquement) évite qu'un applyCam en attente écrase l'auto-pan
    const wrap = cinemaWrapRef.current, im = cinemaImgRef.current
    if (!wrap || !im || !im.naturalWidth) return
    const p = panels[Math.min(panelIdx, panels.length - 1)]
    const CW = wrap.clientWidth, CH = wrap.clientHeight
    const dispW = CW, dispH = CW * (im.naturalHeight / im.naturalWidth)
    const pw = p.w * dispW, ph = p.h * dispH
    const cx = (p.x + p.w / 2) * dispW, cy = (p.y + p.h / 2) * dispH
    // Dwell = courbe à 3 ancres selon la densité de texte : action(0) → normal(~0.15) → bavarde(~0.45+)
    const t = p.text || 0, MID = 0.15, HIGH = 0.45
    const d = t <= MID ? cineMin + (cineNormal - cineMin) * (t / MID)
                       : cineNormal + (cineMax - cineNormal) * Math.min(1, (t - MID) / (HIGH - MID))
    const dwell = Math.max(0.4, d) * 1000
    const advance = () => setPanelIdx((i) => { if (i < panels.length - 1) return i + 1; goNext(); return i })
    const baseK = Math.min((CW / pw) * 0.96, (CH / ph) * 0.96)
    const k = baseK * cinemaZoom                                          // ÉCHELLE de l'utilisateur (pas de fit-largeur forcé)
    if (ph * k > CH * 1.05) {   // à TON échelle, la case dépasse le cadre → auto-pan doux haut→bas
      const tx = CW / 2 - k * cx
      const topY = -(p.y * dispH) * k                      // haut de la case en haut du cadre
      const botY = CH - (p.y + p.h) * dispH * k             // bas de la case en bas du cadre
      setCamTransition('none'); setCamXform(`translate(${tx}px, ${topY}px) scale(${k})`)
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => {
        setCamTransition(`transform ${dwell}ms linear`)
        setCamXform(`translate(${tx}px, ${botY}px) scale(${k})`)
      }))
      cinemaTimerRef.current = setTimeout(advance, dwell + 250)
      return () => { cancelAnimationFrame(raf); clearTimeout(cinemaTimerRef.current) }
    }
    // Case qui tient dans le cadre → cadrage statique, transition FIABLE (posée avant le transform).
    applyCam('transform .5s cubic-bezier(.4,0,.2,1)', `translate(${CW / 2 - k * cx}px, ${CH / 2 - k * cy}px) scale(${k})`)
    cinemaTimerRef.current = setTimeout(advance, dwell)
    return () => clearTimeout(cinemaTimerRef.current)
  }, [cinema, cinemaPlaying, panels, panelIdx, detecting, cinemaZoom, cineMin, cineNormal, cineMax, fullscreen, isLandscape, resizeTick]) // eslint-disable-line
  const setCineMinValue = (v) => { setCineMin(v); patchActiveState({ cineMin: v }) }
  const setCineNormalValue = (v) => { setCineNormal(v); patchActiveState({ cineNormal: v }) }
  const setCineMaxValue = (v) => { setCineMax(v); patchActiveState({ cineMax: v }) }

  // Rend la découpe (planche + contours rouges + n°) et l'enregistre sur le serveur pour analyse.
  const [panelSaved, setPanelSaved] = useState('')
  const savePanelDebug = async () => {
    const im = cinemaImgRef.current
    if (!im || !im.naturalWidth) return
    const W = Math.min(900, im.naturalWidth)
    const sc = W / im.naturalWidth
    const H = Math.round(im.naturalHeight * sc)
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H
    const ctx = cv.getContext('2d')
    ctx.drawImage(im, 0, 0, W, H)
    ctx.lineWidth = 3; ctx.strokeStyle = '#e50914'; ctx.font = 'bold 22px sans-serif'
    panels.forEach((p, i) => {
      const x = p.x * W, y = p.y * H, pw = p.w * W, ph = p.h * H
      ctx.strokeRect(x, y, pw, ph)
      const tag = String(i + 1)
      ctx.fillStyle = '#e50914'; ctx.fillRect(x + 2, y + 2, 14 + tag.length * 13, 28)
      ctx.fillStyle = '#fff'; ctx.fillText(tag, x + 7, y + 23)
    })
    let url
    try { url = cv.toDataURL('image/png') } catch { setPanelSaved('erreur (image protégée)'); return }
    const name = `${mangaId}_${chapterNum}_p${String(current).padStart(2, '0')}_n${panels.length}`
    setPanelSaved('…')
    try { const r = await api.savePanelDebug(name, url); setPanelSaved(r?.ok ? `enregistré : ${r.name}` : 'échec') }
    catch { setPanelSaved('échec réseau') }
    setTimeout(() => setPanelSaved(''), 4000)
  }
  // Navigation case par case : tiers gauche → précédente, sinon suivante. Passe par stepPanel
  // → au bord d'une planche, on enchaîne sur la planche voisine (et « précédente » revient à
  // la DERNIÈRE case de la planche d'avant, comme via la télécommande).
  const cinemaStep = (clientX, el) => {
    if (panelDebug) return
    const r = el.getBoundingClientRect()
    stepPanel(clientX - r.left < r.width * 0.26 ? -1 : 1)
  }
  const cinemaClick = (e) => { if (!IS_TOUCH) cinemaStep(e.clientX, e.currentTarget) }   // desktop
  // Tactile : pincement = mise à l'échelle utilisateur (par-dessus le cadrage), glisser = pan,
  // tap = navigation. Permet de zoomer soi-même une case (utile en paysage).
  const onCinTouchStart = (e) => {
    if (panelDebug) return
    if (e.touches.length === 2) {
      const a = e.touches[0], b = e.touches[1]
      cinPinchRef.current = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, base: cinemaZoom }
      cinPanRef.current = null; setCinInteract(true)
    } else if (e.touches.length === 1 && cinemaZoom > 1.01) {
      const t = e.touches[0]
      cinPanRef.current = { px: cinemaPan.x, py: cinemaPan.y, tx: t.clientX, ty: t.clientY, moved: false }
    }
  }
  const onCinTouchMove = (e) => {
    if (cinPinchRef.current && e.touches.length === 2) {
      const a = e.touches[0], b = e.touches[1]
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      setCinemaZoom(cinPinchRef.current.base * (d / cinPinchRef.current.d0))
      return
    }
    if (cinPanRef.current && e.touches.length === 1) {
      const t = e.touches[0], dx = t.clientX - cinPanRef.current.tx, dy = t.clientY - cinPanRef.current.ty
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) { cinPanRef.current.moved = true; setCinInteract(true) }
      setCinemaPan({ x: cinPanRef.current.px + dx, y: cinPanRef.current.py + dy })
    }
  }
  const onCinTouchEnd = (e) => {
    if (cinPinchRef.current) { cinPinchRef.current = null; setCinInteract(false); return }
    if (cinPanRef.current) { const moved = cinPanRef.current.moved; cinPanRef.current = null; setCinInteract(false); if (moved) return }
    const t = e.changedTouches[0]
    cinemaStep(t.clientX, e.currentTarget)
  }
  const dockOnRight = !dockPos || (dockPos.x + 30 > window.innerWidth / 2)   // côté d'aimantation (pour l'onglet masqué)
  // Quel dock afficher (option user) : le dock de BASE complet (classique) OU celui du cinéma.
  // Piloté UNIQUEMENT par le choix → le dock sélectionné s'affiche toujours (pas de trou).
  const showClassicDock = dockShow && dockKind === 'classic' && loaded && images.length > 0
  const showCinemaDock = dockShow && dockKind === 'cinema' && loaded && images.length > 0
  // Garde le dock dans l'écran quand on tourne le téléphone (paysage ⇄ portrait) ou qu'on redimensionne.
  useEffect(() => {
    const clampDock = () => setDockPos((p) => {
      if (!p) return p
      const x = Math.max(6, Math.min(window.innerWidth - 100, p.x))
      const y = Math.max(6, Math.min(window.innerHeight - 130, p.y))
      return (x === p.x && y === p.y) ? p : { x, y }
    })
    clampDock()
    window.addEventListener('resize', clampDock)
    window.addEventListener('orientationchange', clampDock)
    return () => { window.removeEventListener('resize', clampDock); window.removeEventListener('orientationchange', clampDock) }
  }, [])
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
  // « Zoomé au-delà de l'échelle de base » = pincement en cours (zoomPct dépasse la base) OU loupe.
  // On ne bloque la navigation de page QUE dans ce cas — une base > 100 % (chips) laisse tourner
  // les pages normalement (fix : avant, toute échelle > 100 % bloquait le changement de page).
  const isPinchedIn = () => zoom > 1 || zoomPctRef.current > baseScaleRef.current + 0.5
  const imgRef = useRef()
  const flipRef = useRef()    // conteneur qui pivote (page)
  const shadeRef = useRef()   // ombre en dégradé qui balaie la page
  const num = Number(chapterNum)
  const lastTapRef = useRef({ t: 0, x: 0, y: 0 })
  const panStartRef = useRef(null)
  const touchStartRef = useRef({ x: 0, y: 0 })
  const touchMovedRef = useRef(false)
  const pinchRef = useRef(null)             // pincement 2 doigts en cours : { d0, base, z }
  const multiRef = useRef(false)            // un geste multi-touch a eu lieu → pas de nav de page dessus

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
    goToLastPanelRef.current = false   // on avance → la planche suivante démarre à la 1re case
    if (current < images.length - 1) { setCurrent((p) => p + 1); setImgReady(false); slide(1); return }
    // fin du chapitre → chapitre suivant, 1ʳᵉ planche
    if (nextChapNum != null) navigate(`/manga/${mangaId}/read/${nextChapNum}?p=0`)
  }, [current, images.length, slide, nextChapNum, mangaId, navigate])

  const goPrev = useCallback(() => {
    if (current > 0) { setCurrent((p) => p - 1); setImgReady(false); slide(-1); return }
    // début du chapitre → chapitre précédent, dernière planche
    if (prevChapNum != null) navigate(`/manga/${mangaId}/read/${prevChapNum}?p=last`)
  }, [current, slide, prevChapNum, mangaId, navigate])

  // Commandes venues de la TV (auto-scroll arrivé en bas de planche → page suivante, etc.).
  // Placé APRÈS goNext/goPrev (sinon TDZ dans le tableau de deps → crash au montage).
  useEffect(() => {
    cast.onCmdRef.current = (cmd) => { if (cmd === 'next') goNext(); else if (cmd === 'prev') goPrev() }
    return () => { cast.onCmdRef.current = null }
  }, [cast, goNext, goPrev])

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
      if (isPinchedIn()) return   // pincé (au-delà de la base) → molette = scroll libre, pas de nav
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
    if (e.touches.length === 1 && !pinchRef.current) multiRef.current = false   // nouveau geste 1 doigt
    if (e.touches.length >= 2) {
      multiRef.current = true
      const a = e.touches[0], b = e.touches[1]
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      pinchRef.current = { d0: d || 1, base: zoomPctRef.current, z: zoomPctRef.current }
      return
    }
    if (zoomed) panStartRef.current = { px: pan.x, py: pan.y, tx: t.clientX, ty: t.clientY }
  }, [zoomed, pan])

  const onTouchMove = useCallback((e) => {
    if (showMenuRef.current) return
    if (e.touches.length >= 2) multiRef.current = true
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
    // Geste multi-touch (pincement) → n'est JAMAIS un tap/double-tap/swipe de page (fix molette+pincement).
    if (multiRef.current) { if (e.touches.length === 0) multiRef.current = false; return }
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
    if (isPinchedIn()) return   // pincé au-delà de la base → pas de changement de page (mais base >100 % OK)

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
    if (isPinchedIn()) return   // pincé au-delà de la base → pas de changement de page (mais base >100 % OK)
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
                alignItems: isLandscape ? 'center' : 'flex-start',   // paysage : planche entière, centrée
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
                  // Portrait : échelle sur la LARGEUR (scroll vertical). Paysage : échelle sur la
                  // HAUTEUR → planche ENTIÈRE visible, centrée (garde-fou paysage).
                  ...(isLandscape
                    ? { height: `${zoomPct}%`, width: 'auto', maxWidth: 'none', margin: 'auto' }
                    : { width: `${zoomPct}%`, height: 'auto', margin: 'auto 0' }),
                  display: 'block', userSelect: 'none', flexShrink: 0,
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

        {/* ── Calque Mode Cinéma : caméra qui cadre la case courante (sens manga) ── */}
        {cinema && loaded && images.length > 0 && (
          <div ref={cinemaWrapRef} onClick={cinemaClick}
            onTouchStart={onCinTouchStart} onTouchMove={onCinTouchMove} onTouchEnd={onCinTouchEnd}
            style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#0a0a0a',
              zIndex: 20, cursor: 'pointer', touchAction: 'none' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%',
              transform: panelDebug ? fitXform : camXform, transformOrigin: '0 0',
              transition: (panelDebug || cinInteract) ? 'none' : camTransition, willChange: 'transform' }}>
              <img ref={cinemaImgRef} src={images[current]} alt="" draggable={false}
                onLoad={runDetect} style={{ width: '100%', display: 'block' }} />
              {/* Vue debug : rectangles + numéro d'ordre de lecture, calés sur l'image */}
              {panelDebug && panels.map((p, i) => (
                <div key={i} style={{ position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`,
                  width: `${p.w * 100}%`, height: `${p.h * 100}%`, boxSizing: 'border-box',
                  border: '2px solid #e50914', background: 'rgba(229,9,20,.10)' }}>
                  <span style={{ position: 'absolute', top: 2, right: 2, background: '#e50914', color: '#fff',
                    fontSize: '.7rem', fontWeight: 800, padding: '1px 5px', borderRadius: 4 }}>{i + 1}</span>
                </div>
              ))}
            </div>
            {/* léger vignettage pour l'ambiance cinéma (masqué en debug) */}
            {!panelDebug && <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
              boxShadow: 'inset 0 0 120px 30px rgba(0,0,0,.55)' }} />}
            {/* Bouton debug (ne déclenche pas le tap de navigation) */}
            <button onClick={(e) => { e.stopPropagation(); setPanelDebug((v) => !v) }} title="Voir les cases détectées"
              style={{ position: 'absolute', top: 8, left: 8, zIndex: 3, border: 'none', cursor: 'pointer',
                background: panelDebug ? '#e50914' : 'rgba(0,0,0,.55)', color: '#fff', borderRadius: 6,
                padding: '.25rem .5rem', fontSize: '.72rem', fontWeight: 700 }}>⧉ {panels.length}</button>
            {panelDebug && (
              <button onClick={(e) => { e.stopPropagation(); savePanelDebug() }} title="Enregistrer cette découpe sur le serveur"
                style={{ position: 'absolute', top: 8, left: 58, zIndex: 3, border: 'none', cursor: 'pointer',
                  background: 'rgba(0,0,0,.55)', color: '#fff', borderRadius: 6, padding: '.25rem .5rem',
                  fontSize: '.72rem', fontWeight: 700 }}>💾 Enregistrer</button>
            )}
            {panelSaved && (
              <div style={{ position: 'absolute', top: 40, left: 8, zIndex: 3, background: 'rgba(0,0,0,.7)',
                color: '#fff', borderRadius: 6, padding: '.2rem .5rem', fontSize: '.7rem' }}>{panelSaved}</div>
            )}
            {/* Auto-lecture : play/pause (avance case par case, dwell adapté au texte).
                Masqué si le dock cinéma est affiché (il porte déjà le play) → pas de doublon. */}
            {!panelDebug && !showCinemaDock && (
              <button onClick={(e) => { e.stopPropagation(); setCinemaPlaying((v) => !v) }}
                title={cinemaPlaying ? 'Pause auto-lecture' : 'Lancer l’auto-lecture'}
                style={{ position: 'absolute', bottom: 40, right: 12, zIndex: 3, width: 44, height: 44, borderRadius: '50%',
                  border: 'none', cursor: 'pointer', background: cinemaPlaying ? '#e50914' : 'rgba(0,0,0,.6)', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 12px rgba(0,0,0,.5)' }}>
                {cinemaPlaying
                  ? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                  : <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>}
              </button>
            )}
            <div style={{ position: 'absolute', bottom: 8, left: 0, right: 0, textAlign: 'center',
              color: 'rgba(255,255,255,.7)', fontSize: '.72rem', pointerEvents: 'none',
              textShadow: '0 1px 3px #000' }}>
              {detecting
                ? 'Découpage en cours… (planche entière en attendant)'
                : panelDebug
                  ? `${panels.length} case(s) détectée(s) — ordre de lecture affiché`
                  : `Case ${Math.min(panelIdx + 1, panels.length)} / ${panels.length}${cinemaZoom > 1.01 ? ` · ×${cinemaZoom.toFixed(1)}` : ''} · tape à droite = suivante, pince pour zoomer`}
            </div>
          </div>
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

      {/* Dock flottant CLASSIQUE : play/pause + vitesse + échelle + plein écran. Déplaçable (poignée),
          aimanté au bord au relâchement, masquable en onglet sur le côté (façon bulle d'OS). */}
      {showClassicDock && (
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5, cursor: 'grab', touchAction: 'none', padding: '2px 0' }}
              onPointerDown={onDockDown} onPointerMove={onDockMove} onPointerUp={onDockUp}>
              <span style={{ display: 'flex', gap: 2, paddingLeft: 4 }}>
                {[0, 1, 2].map((i) => <span key={i} style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(255,255,255,.4)' }} />)}
              </span>
              <button onClick={() => setDockHiddenP(true)} title="Masquer sur le côté"
                style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.55)', cursor: 'pointer', padding: '0 2px', fontSize: '.9rem', lineHeight: 1 }}>⤫</button>
            </div>
            {/* Grille 2×2 de contrôles */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
              <button onClick={() => { if (!autoScroll) { toggleAutoScroll(); setScrollPaused(false) } else setScrollPaused((v) => !v) }}
                title={(!autoScroll || scrollPaused) ? 'Lancer le défilement' : 'Pause'}
                style={{ height: 36, borderRadius: 10, border: 'none', cursor: 'pointer', background: '#e50914', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {(!autoScroll || scrollPaused)
                  ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>}
              </button>
              <button title="Vitesse : tap pour changer, ou maintenir + glisser haut/bas"
                onPointerDown={(e) => onScrubDown(e, settings.speedMults, speedMult, setSpeedMultValue)}
                onPointerMove={onScrubMove} onPointerUp={(e) => onScrubUp(e, cycleSpeedMult)}
                style={{ height: 36, borderRadius: 10, border: scrubbing ? '1px solid #e50914' : 'none', cursor: 'ns-resize', touchAction: 'none', background: 'rgba(255,255,255,.1)', color: '#fff', fontWeight: 800, fontSize: '.8rem' }}>×{speedMult}</button>
              <button title="Taille de planche : tap pour changer, ou maintenir + glisser haut/bas"
                onPointerDown={(e) => onScrubDown(e, settings.scaleLevels, baseScaleRef.current, setScaleValue)}
                onPointerMove={onScrubMove} onPointerUp={(e) => onScrubUp(e, cycleScale)}
                style={{ height: 36, borderRadius: 10, border: scrubbing ? '1px solid #e50914' : 'none', cursor: 'ns-resize', touchAction: 'none', background: 'rgba(255,255,255,.1)', color: zoomPct === baseScaleRef.current ? '#fff' : '#e50914', fontWeight: 800, fontSize: '.8rem' }}>{baseScaleRef.current}%</button>
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

      {/* Dock flottant CINÉMA : 🎬 activation + play auto-lecture + échelle + plein écran.
          Même infra déplaçable/masquable que le classique (position/masquage partagés). */}
      {showCinemaDock && (
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5, cursor: 'grab', touchAction: 'none', padding: '2px 0' }}
              onPointerDown={onDockDown} onPointerMove={onDockMove} onPointerUp={onDockUp}>
              <span style={{ display: 'flex', gap: 2, paddingLeft: 4 }}>
                {[0, 1, 2].map((i) => <span key={i} style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(255,255,255,.4)' }} />)}
              </span>
              <button onClick={() => setDockHiddenP(true)} title="Masquer sur le côté"
                style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.55)', cursor: 'pointer', padding: '0 2px', fontSize: '.9rem', lineHeight: 1 }}>⤫</button>
            </div>
            {/* Grille 2×2 : 🎬 activation · play auto-lecture · échelle · plein écran */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
              <button onClick={toggleCinema} title="Activer / couper le Mode Cinéma"
                style={{ height: 36, borderRadius: 10, border: 'none', cursor: 'pointer', background: cinema ? '#e50914' : 'rgba(255,255,255,.1)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ClapIcon size={17} />
              </button>
              <button onClick={() => { if (!cinema) { toggleCinema(); setCinemaPlaying(true) } else { setCinemaPlaying((v) => !v) } }}
                title={cinemaPlaying ? 'Pause auto-lecture' : 'Lancer l’auto-lecture'}
                style={{ height: 36, borderRadius: 10, border: 'none', cursor: 'pointer', background: cinemaPlaying ? '#e50914' : 'rgba(255,255,255,.1)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {cinemaPlaying
                  ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>}
              </button>
              <button title="Échelle cinéma : tap pour changer, ou maintenir + glisser haut/bas"
                onPointerDown={(e) => onScrubDown(e, settings.scaleLevels, Math.round(cinemaZoom * 100), (v) => setCinemaZoom(v / 100))}
                onPointerMove={onScrubMove} onPointerUp={(e) => onScrubUp(e, cycleCinemaScale)}
                style={{ height: 36, borderRadius: 10, border: scrubbing ? '1px solid #e50914' : 'none', cursor: 'ns-resize', touchAction: 'none', background: 'rgba(255,255,255,.1)', color: '#fff', fontWeight: 800, fontSize: '.8rem' }}>{Math.round(cinemaZoom * 100)}%</button>
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

      {/* Modale Cast : scanner le QR de la TV, ou saisir le code */}
      {castOpen && (
        <div onClick={(e) => { if (e.target === e.currentTarget) { stopScan(); setCastOpen(false) } }}
          style={{ position: 'fixed', inset: 0, zIndex: 600, background: 'rgba(0,0,0,.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ width: '100%', maxWidth: 420, background: '#17171b', borderRadius: 16,
            padding: '1.4rem', boxShadow: '0 10px 50px rgba(0,0,0,.6)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontWeight: 800, fontSize: '1.05rem', marginBottom: '.4rem' }}>
              <CastIcon size={18} /> Diffuser sur une TV
            </div>
            <div style={{ fontSize: '.85rem', color: 'rgba(255,255,255,.55)', lineHeight: 1.5, marginBottom: '1rem' }}>
              Choisis un appareil Cast, ou ouvre <b style={{ color: '#fff' }}>{location.host}/tv</b> sur la TV et scanne le QR (ou tape le code).
            </div>
            {/* Sélecteur d'appareils Cast (Chromecast/Cast intégré, via Chrome) — absent sur iOS */}
            {('PresentationRequest' in window) ? (
              <button onClick={castToDevice}
                style={{ width: '100%', padding: '.75rem', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: '#e50914', color: '#fff', fontWeight: 800, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', gap: '.45rem', marginBottom: '.6rem' }}>
                <CastIcon size={17} /> Caster sur un appareil
              </button>
            ) : (
              <div style={{ fontSize: '.82rem', color: '#fff', background: 'rgba(229,9,20,.18)',
                border: '1px solid rgba(229,9,20,.5)', borderRadius: 10, padding: '.6rem .7rem', marginBottom: '.6rem', lineHeight: 1.45 }}>
                📷 <b>Le plus simple ici :</b> scanne le QR de la TV avec ton <b>app Appareil photo</b> → l’app s’ouvre et lance la diffusion toute seule.
              </div>
            )}
            {/* Scanner intégré */}
            <button onClick={scanning ? stopScan : startScan}
              style={{ width: '100%', padding: '.7rem', borderRadius: 10, border: '1px solid rgba(255,255,255,.15)', cursor: 'pointer',
                background: scanning ? 'rgba(229,9,20,.25)' : 'rgba(255,255,255,.08)', color: '#fff', fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '.4rem', marginBottom: '.6rem' }}>
              📷 {scanning ? 'Arrêter le scan' : 'Scanner le QR'}
            </button>
            {scanning && (
              <video ref={scanVideoRef} muted playsInline
                style={{ width: '100%', maxHeight: '46vh', borderRadius: 12, background: '#000', marginBottom: '.6rem', objectFit: 'cover' }} />
            )}
            {scanErr && <div style={{ color: '#e50914', fontSize: '.8rem', marginBottom: '.6rem', textAlign: 'center' }}>{scanErr}</div>}
            <input value={castCode} onChange={(e) => setCastCode(e.target.value.toUpperCase().slice(0, 4))}
              onKeyDown={(e) => { if (e.key === 'Enter') startCast(castCode) }}
              autoFocus placeholder="CODE" inputMode="text" autoCapitalize="characters"
              style={{ width: '100%', textAlign: 'center', fontSize: '2rem', fontWeight: 900, letterSpacing: '.35em',
                padding: '.6rem', borderRadius: 12, border: '1px solid rgba(255,255,255,.18)',
                background: '#0e0e12', color: '#fff', boxSizing: 'border-box' }} />
            {cast.err && <div style={{ color: '#e50914', fontSize: '.82rem', marginTop: '.6rem', textAlign: 'center' }}>{cast.err}</div>}
            <div style={{ display: 'flex', gap: '.6rem', marginTop: '1.1rem' }}>
              <button onClick={() => { stopScan(); setCastOpen(false) }}
                style={{ flex: 1, padding: '.7rem', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: 'rgba(255,255,255,.1)', color: '#fff', fontWeight: 700 }}>Annuler</button>
              <button onClick={() => startCast(castCode)}
                style={{ flex: 1, padding: '.7rem', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: '#e50914', color: '#fff', fontWeight: 800 }}>Diffuser</button>
            </div>
          </div>
        </div>
      )}

      {/* TÉLÉCOMMANDE : diffusion active → le tel pilote la TV (on regarde la TV, pas le tel).
          Deux modes : CINÉMA (caméra case-par-case) et NORMALE (lecture + zoom + souris/trackpad). */}
      {casting && (() => {
        const CAST_ZOOM = [50, 60, 70, 80, 90, 100, 125, 150, 200, 250, 300]   // zoom page/TV (sous 100 % possible)
        const BRIGHT = [50, 60, 70, 80, 90, 100]
        const FILTERS = [['none', 'Aucun'], ['sepia', 'Sépia'], ['night', 'Nuit']]
        const cycleCastZoom = () => { const c = Math.round(castZoom * 100); const i = CAST_ZOOM.indexOf(c); setCastZoom(CAST_ZOOM[(i + 1) % CAST_ZOOM.length] / 100) }
        const cycleBright = () => { const i = BRIGHT.indexOf(brightness); setBrightnessValue(BRIGHT[i < 0 ? BRIGHT.length - 1 : (i + 1) % BRIGHT.length]) }
        const cycleFilter = () => { const i = FILTERS.findIndex((f) => f[0] === readFilter); setFilterValue(FILTERS[(i + 1) % FILTERS.length][0]) }
        const filterLbl = (FILTERS.find((f) => f[0] === readFilter) || FILTERS[0])[1]
        const seg = (on) => ({ flex: 1, padding: '.6rem', borderRadius: 9, border: 'none', cursor: 'pointer',
          background: on ? '#e50914' : 'transparent', color: on ? '#fff' : 'rgba(255,255,255,.65)', fontWeight: 800,
          fontSize: '.85rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '.35rem' })
        const navBtn = (bg) => ({ height: 60, minWidth: 88, borderRadius: 16, border: 'none', cursor: 'pointer',
          background: bg, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' })
        const chapBtn = (disabled) => ({ flex: 1, padding: '.8rem', borderRadius: 12, border: 'none',
          cursor: disabled ? 'default' : 'pointer', background: 'rgba(255,255,255,.08)',
          color: disabled ? 'rgba(255,255,255,.3)' : '#fff', fontWeight: 700, fontSize: '.88rem' })
        const tile = (on) => ({ height: 58, borderRadius: 12, border: on ? 'none' : '1px solid rgba(255,255,255,.12)',
          cursor: 'pointer', background: on ? '#e50914' : 'rgba(255,255,255,.08)', color: '#fff', fontWeight: 700,
          fontSize: '.8rem', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '.15rem' })
        const scrubTile = { ...tile(false), cursor: 'ns-resize', touchAction: 'none',
          border: scrubbing ? '1px solid #e50914' : '1px solid rgba(255,255,255,.12)' }
        const cap = { fontSize: '.62rem', textTransform: 'uppercase', letterSpacing: '.04em', opacity: .55 }
        return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 450, background: '#0c0c10', color: '#fff',
          display: 'flex', flexDirection: 'column', userSelect: 'none', overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '.9rem 1.1rem' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.5rem', fontWeight: 800, fontSize: '1.02rem' }}>
              <CastIcon size={18} /> Télécommande TV
            </span>
            <button onClick={stopCast}
              style={{ padding: '.5rem .85rem', borderRadius: 10, border: 'none', cursor: 'pointer',
                background: '#e50914', color: '#fff', fontWeight: 800, fontSize: '.82rem' }}>Arrêter</button>
          </div>

          {/* Sélecteur de mode (layout) — indépendant du flag Cinéma, qui a son propre bouton */}
          <div style={{ display: 'flex', width: '88%', margin: '0 auto', background: 'rgba(255,255,255,.06)', borderRadius: 12, padding: 4, gap: 4 }}>
            <button onClick={() => { setRemoteMode('cine'); resetCastView() }} style={seg(remoteMode === 'cine')}><ClapIcon size={15} /> Cinématique</button>
            <button onClick={() => { setRemoteMode('normal'); setRemoteCinema(false) }} style={seg(remoteMode === 'normal')}>📖 Normale</button>
          </div>
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,.45)', fontSize: '.82rem', margin: '.55rem 0 0' }}>
            👀 Regarde la TV · Chapitre {chapterNum}
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.2rem', padding: '1rem 1.3rem' }}>
            <div style={{ fontSize: '3rem', fontWeight: 900, lineHeight: 1 }}>
              {loaded ? current + 1 : '…'}<span style={{ opacity: .35, fontSize: '1.4rem', fontWeight: 700 }}> / {images.length || '…'}</span>
            </div>

            {remoteMode === 'cine' ? (
              /* ── MODE CINÉMATIQUE ── */
              <>
                {/* Activer / couper le Cinéma sur la TV (indépendant du reste) */}
                <button onClick={toggleCinema} style={{ ...tile(cinema), width: '88%', height: 48, flexDirection: 'row', gap: '.5rem' }}>
                  <ClapIcon size={17} /> Cinéma {cinema ? 'ON' : 'OFF'}
                </button>
                <button onClick={() => { if (!cinema) { toggleCinema(); setCinemaPlaying(true) } else setCinemaPlaying((v) => !v) }}
                  style={{ width: '88%', height: 62, borderRadius: 16, border: 'none', cursor: 'pointer',
                    background: cinemaPlaying ? '#e50914' : 'rgba(255,255,255,.12)', color: '#fff', fontWeight: 800,
                    fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '.5rem' }}>
                  {cinemaPlaying
                    ? <><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg> Pause</>
                    : <><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg> Lecture auto</>}
                </button>
                <div style={{ display: 'flex', gap: '1.1rem' }}>
                  <button onClick={() => stepPanel(-1)} title="Case précédente" style={navBtn('rgba(255,255,255,.1)')}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="18 4 6 12 18 20 18 4"/></svg>
                  </button>
                  <button onClick={() => stepPanel(1)} title="Case suivante" style={navBtn('#e50914')}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 18 12 6 20 6 4"/></svg>
                  </button>
                </div>
                {/* Zoom caméra + confort (filtre / luminosité), comme en normal */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '.6rem', width: '88%' }}>
                  <button title="Zoom caméra : tap ou maintenir + glisser" style={scrubTile}
                    onPointerDown={(e) => onScrubDown(e, settings.scaleLevels, Math.round(cinemaZoom * 100), (v) => setCinemaZoom(v / 100))}
                    onPointerMove={onScrubMove} onPointerUp={(e) => onScrubUp(e, cycleCinemaScale)}>
                    <span style={cap}>Zoom</span>{Math.round(cinemaZoom * 100)}%
                  </button>
                  <button title="Luminosité : tap ou maintenir + glisser" style={scrubTile}
                    onPointerDown={(e) => onScrubDown(e, BRIGHT, brightness, setBrightnessValue)}
                    onPointerMove={onScrubMove} onPointerUp={(e) => onScrubUp(e, cycleBright)}>
                    <span style={cap}>Lumino.</span>{brightness}%
                  </button>
                  <button onClick={cycleFilter} style={tile(readFilter !== 'none')}>
                    <span style={cap}>Filtre</span>{filterLbl}
                  </button>
                </div>
              </>
            ) : (
              /* ── MODE NORMALE ── */
              <>
                <div style={{ display: 'flex', gap: '1.1rem' }}>
                  <button onClick={goPrev} title="Page précédente" style={navBtn('rgba(255,255,255,.1)')}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="18 4 6 12 18 20 18 4"/></svg>
                  </button>
                  <button onClick={goNext} title="Page suivante" style={navBtn('#e50914')}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 18 12 6 20 6 4"/></svg>
                  </button>
                </div>
                <input type="range" min={0} max={Math.max(0, images.length - 1)} value={current}
                  onChange={(e) => { setCurrent(+e.target.value); setImgReady(false) }}
                  style={{ width: '88%', accentColor: '#e50914' }} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '.6rem', width: '88%' }}>
                  <button style={tile(castMouse)}
                    onClick={() => setCastMouse((v) => { const n = !v; if (!n) setCastPan({ x: 0, y: 0 }); return n })}>
                    <span style={cap}>Souris</span>{castMouse ? 'ON' : 'OFF'}
                  </button>
                  <button style={tile(castAutoscroll)}
                    onClick={() => setCastAutoscroll((v) => { const n = !v; if (n) setCastPan({ x: 0, y: 0 }); return n })}>
                    <span style={cap}>Auto-scroll</span>{castAutoscroll ? 'ON' : 'OFF'}
                  </button>
                  <button title="Vitesse de lecture : tap ou maintenir + glisser" style={scrubTile}
                    onPointerDown={(e) => onScrubDown(e, settings.speedMults, speedMult, setSpeedMultValue)}
                    onPointerMove={onScrubMove} onPointerUp={(e) => onScrubUp(e, cycleSpeedMult)}>
                    <span style={cap}>Vitesse</span>×{speedMult}
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '.6rem', width: '88%' }}>
                  <button title="Zoom page : tap ou maintenir + glisser" style={scrubTile}
                    onPointerDown={(e) => onScrubDown(e, CAST_ZOOM, Math.round(castZoom * 100), (v) => setCastZoom(v / 100))}
                    onPointerMove={onScrubMove} onPointerUp={(e) => onScrubUp(e, cycleCastZoom)}>
                    <span style={cap}>Zoom</span>{Math.round(castZoom * 100)}%
                  </button>
                  <button title="Luminosité : tap ou maintenir + glisser" style={scrubTile}
                    onPointerDown={(e) => onScrubDown(e, BRIGHT, brightness, setBrightnessValue)}
                    onPointerMove={onScrubMove} onPointerUp={(e) => onScrubUp(e, cycleBright)}>
                    <span style={cap}>Lumino.</span>{brightness}%
                  </button>
                  <button onClick={cycleFilter} style={tile(readFilter !== 'none')}>
                    <span style={cap}>Filtre</span>{filterLbl}
                  </button>
                </div>
                {castMouse && (
                  <div onPointerDown={onPadDown} onPointerMove={onPadMove} onPointerUp={onPadUp} onPointerCancel={onPadUp}
                    style={{ width: '88%', height: 150, borderRadius: 16, background: 'rgba(255,255,255,.05)',
                      border: '1px dashed rgba(255,255,255,.22)', touchAction: 'none', display: 'flex', flexDirection: 'column',
                      alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,.4)', fontSize: '.82rem', textAlign: 'center', gap: '.3rem' }}>
                    <span>Glisse pour déplacer la vue</span>
                    <span>double-tap pour zoomer · {Math.round(castZoom * 100)}%</span>
                  </div>
                )}
              </>
            )}

            {/* Commun : chapitres + réglages */}
            <div style={{ display: 'flex', gap: '.8rem', width: '88%' }}>
              <button disabled={prevChapNum == null} style={chapBtn(prevChapNum == null)}
                onClick={() => prevChapNum != null && navigate(`/manga/${mangaId}/read/${prevChapNum}?p=0`)}>‹ Chapitre</button>
              <button disabled={nextChapNum == null} style={chapBtn(nextChapNum == null)}
                onClick={() => nextChapNum != null && navigate(`/manga/${mangaId}/read/${nextChapNum}?p=0`)}>Chapitre ›</button>
            </div>
            <button onClick={() => setShowReaderMenu(true)}
              style={{ width: '88%', padding: '.8rem', borderRadius: 12, border: '1px solid rgba(255,255,255,.15)',
                cursor: 'pointer', background: 'rgba(255,255,255,.06)', color: '#fff', fontWeight: 700, fontSize: '.88rem' }}>
              ⚙︎ Réglages / profil
            </button>
          </div>
        </div>
        )
      })()}

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

              {/* Mode Cinéma (bêta) : lecture case par case en sens manga */}
              <button onClick={toggleCinema} style={toggleRow(cinema)}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}><ClapIcon size={16} /> Mode Cinéma <span style={{ opacity: .6, fontWeight: 400 }}>(bêta)</span></span><span style={pill(cinema)}>{cinema ? 'ON' : 'OFF'}</span>
              </button>
              {cinema && (
                <>
                  <button onClick={() => setCinemaPlaying((v) => !v)} style={toggleRow(cinemaPlaying)}>
                    <span>Auto-lecture (avance seule)</span><span style={pill(cinemaPlaying)}>{cinemaPlaying ? 'ON' : 'OFF'}</span>
                  </button>
                  <div style={section}>
                    <div style={label}>Pause action — case sans texte (s)</div>
                    <div style={chipRow}>
                      {CINE_DWELL_CHOICES.map((v) => (
                        <button key={v} onClick={() => setCineMinValue(v)} style={chip(Math.abs(cineMin - v) < 0.001)}>{v}s</button>
                      ))}
                    </div>
                  </div>
                  <div style={section}>
                    <div style={label}>Pause normale — peu de texte (s)</div>
                    <div style={chipRow}>
                      {CINE_DWELL_CHOICES.map((v) => (
                        <button key={v} onClick={() => setCineNormalValue(v)} style={chip(Math.abs(cineNormal - v) < 0.001)}>{v}s</button>
                      ))}
                    </div>
                  </div>
                  <div style={section}>
                    <div style={label}>Pause bavarde — beaucoup de texte (s)</div>
                    <div style={chipRow}>
                      {CINE_DWELL_CHOICES.map((v) => (
                        <button key={v} onClick={() => setCineMaxValue(v)} style={chip(Math.abs(cineMax - v) < 0.001)}>{v}s</button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* Cast : diffuser la lecture sur une TV (ouvrir /tv sur la TV, entrer le code) */}
              {casting ? (
                <button onClick={stopCast} style={toggleRow(true)}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.45rem' }}><CastIcon size={16} /> Diffusion sur la TV en cours</span>
                  <span style={pill(true)}>ARRÊTER</span>
                </button>
              ) : (
                <button onClick={() => { cast.setErr(''); setCastCode(''); setCastOpen(true) }} style={toggleRow(false)}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.45rem' }}><CastIcon size={16} /> Diffuser sur une TV</span>
                  <span style={{ ...pill(false), fontSize: '1rem' }}>›</span>
                </button>
              )}

              {/* Dock flottant : l'afficher ou non, et lequel (classique auto-scroll / cinéma) */}
              <button onClick={() => setDockShowP(!dockShow)} style={toggleRow(dockShow)}>
                <span>Afficher le dock flottant</span><span style={pill(dockShow)}>{dockShow ? 'ON' : 'OFF'}</span>
              </button>
              {dockShow && (
                <div style={section}>
                  <div style={label}>Type de dock</div>
                  <div style={chipRow}>
                    <button onClick={() => setDockKindP('classic')} style={chip(dockKind === 'classic')}>Classique</button>
                    <button onClick={() => setDockKindP('cinema')} style={{ ...chip(dockKind === 'cinema'), display: 'inline-flex', alignItems: 'center', gap: '.35rem' }}><ClapIcon size={15} /> Cinéma</button>
                  </div>
                </div>
              )}

              {/* Échelle — MÉCA DE BASE : le % change (le pincement zoome librement au-delà).
                  En cinéma, ces chips pilotent le ZOOM caméra (ta mise à l'échelle). */}
              {(() => { const activeScale = cinema ? Math.round(cinemaZoom * 100) : zoomPct; return (
              <div style={section}>
                <div style={label}>Taille de planche{cinema ? ' (cinéma)' : ''} (pincer pour zoomer librement)</div>
                <div style={chipRow}>
                  {settings.scaleLevels.map((v) => (
                    <button key={v} onClick={() => setScaleValue(v)} style={chip(activeScale === v)}>{v}%</button>
                  ))}
                  {!settings.scaleLevels.includes(activeScale) && (
                    <span style={{ ...chip(true), cursor: 'default' }}>{activeScale}%</span>
                  )}
                </div>
              </div>) })()}

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

              {/* Affichage des boutons de la barre (chapitre / Début) */}
              <button onClick={() => patchActiveVisible({ chapnav: !vis.chapnav })} style={toggleRow(!!vis.chapnav)}>
                <span>Boutons chapitre préc./suiv.</span><span style={pill(!!vis.chapnav)}>{vis.chapnav ? 'ON' : 'OFF'}</span>
              </button>
              <button onClick={() => patchActiveVisible({ restart: !vis.restart })} style={toggleRow(!!vis.restart)}>
                <span>Bouton « Début »</span><span style={pill(!!vis.restart)}>{vis.restart ? 'ON' : 'OFF'}</span>
              </button>

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
