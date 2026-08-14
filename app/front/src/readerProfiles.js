// Profils de lecture — SYNCHRONISÉS PAR COMPTE (backend), donc multi-appareils, sans
// gestion de cache locale. Un profil = quelles options sont VISIBLES + leurs VALEURS
// autorisées + les DÉFAUTS + le geste de zoom. Le profil `default` est éditable mais
// non supprimable (fallback, tout activé au départ).
import { api } from './api/client'
import { DEFAULTS } from './readerSettings'

// Le mode « fit-largeur / mise à l'échelle » est la MÉCA DE BASE (toujours active) : ce n'est
// plus une option. Le pincement zoome librement l'échelle. Options togglables restantes :
export const OPTION_KEYS = [
  { key: 'scrollnav', label: 'Navigation à la molette / liseuse' },
  { key: 'autoscroll', label: 'Défilement automatique' },
  { key: 'sensitivity', label: 'Sensibilité de déplacement en zoom (double-tap)' },
  { key: 'chapnav', label: 'Boutons chapitre précédent / suivant' },
  { key: 'restart', label: 'Bouton « Début » (reprendre au début)' },
]

export function makeProfile(id, name, allVisible = true) {
  return {
    id,
    name,
    visible: { scrollnav: allVisible, autoscroll: allVisible, sensitivity: allVisible, chapnav: allVisible, restart: allVisible },
    values: {
      scaleLevels: [...DEFAULTS.scaleLevels],   // % d'échelle proposés (le pincement va au-delà)
      speedMults: [...DEFAULTS.speedMults],     // multiplicateurs de vitesse d'auto-scroll
      pauseLevels: [...DEFAULTS.pauseLevels],   // temps de pause entre planches (s)
      sensLevels: [...DEFAULTS.sensLevels],     // sensibilité de déplacement quand on double-tap
    },
    // État VIVANT : ce qui est réellement ACTIF (échelle, auto-scroll, ×vitesse, pause, sens…).
    // Synchronisé par compte → retrouvé tel quel sur tout appareil / manga du profil, sans
    // ré-activation. Réécrit à chaque changement dans le lecteur. (Le pincement, zoom LIBRE, est
    // transitoire : il ne modifie pas `scale`, qui reste l'échelle de BASE posée par les chips.)
    state: { scale: 100, scaleLandscape: 100, scrollnav: false, autoscroll: false, speedMult: 1, pause: 0, sens: 1, filter: 'none', brightness: 100, cineMin: 1.5, cineNormal: 2.5, cineMax: 5 },
    defaults: {},
  }
}

// Garantit qu'un profil a un `state` + des `values` complets (auto-upgrade des anciens schémas).
export function ensureState(p) {
  if (!p) return p
  const base = { scale: 100, scaleLandscape: 100, scrollnav: false, autoscroll: false, speedMult: 1, pause: 0, sens: 1, filter: 'none', brightness: 100, cineMin: 1.5, cineNormal: 2.5, cineMax: 5 }
  p.state = { ...base, ...(p.state || {}) }
  const old = p.defaults || {}
  if (!(p.state.pause > 0) && typeof old.autoEdgePause === 'number' && old.autoEdgePause > 0) {
    p.state.pause = old.autoEdgePause   // migration de l'ancienne pause de bord
  }
  const V = (p.values = p.values || {})
  // On NE re-rajoute PLUS d'échelles > 100 % de force : ça se rejouait à CHAQUE chargement et
  // faisait « revenir » les niveaux que l'utilisateur avait retirés dans les réglages (même après
  // enregistrement). Les nouveaux profils ont déjà 150/200/300 via DEFAULTS ; on respecte le choix.
  if (!Array.isArray(V.scaleLevels) || !V.scaleLevels.length) V.scaleLevels = [...DEFAULTS.scaleLevels]
  if (!Array.isArray(V.speedMults) || !V.speedMults.length) V.speedMults = [...DEFAULTS.speedMults]
  if (!Array.isArray(V.pauseLevels) || !V.pauseLevels.length) V.pauseLevels = [...DEFAULTS.pauseLevels]
  if (!Array.isArray(V.sensLevels) || !V.sensLevels.length) V.sensLevels = [...DEFAULTS.sensLevels]
  const vis = (p.visible = p.visible || {})
  if (typeof vis.autoscroll !== 'boolean') vis.autoscroll = true
  if (typeof vis.scrollnav !== 'boolean') vis.scrollnav = true
  if (typeof vis.sensitivity !== 'boolean') vis.sensitivity = true
  if (typeof vis.chapnav !== 'boolean') vis.chapnav = true
  if (typeof vis.restart !== 'boolean') vis.restart = true
  return p
}

export function emptyStore() {
  return {
    activeId: 'default',
    defaultId: 'default',
    perManga: {},                       // { mangaId: profileId } — override par manga, par user
    profiles: { default: makeProfile('default', 'Default', true) },
  }
}

// Charge depuis le backend ; au 1er passage, migre l'ancien localStorage en profil « Perso »,
// puis persiste. Retourne toujours un store valide (avec au moins `default`).
export async function loadProfiles(uid) {
  let store = null
  try { store = await api.getReaderProfiles() } catch { store = null }

  if (!store || !store.profiles || !store.profiles.default) {
    store = emptyStore()
    try {
      const raw = localStorage.getItem(`reader_settings_${uid || 'anon'}`)
      if (raw) {
        const s = JSON.parse(raw)
        const p = makeProfile('perso', 'Perso', true)
        if (s.buttons) {   // clés alignées (scrollnav/fitwidth/flip/autoscroll/scale/sensitivity)
          for (const k of Object.keys(p.visible)) {
            if (typeof s.buttons[k] === 'boolean') p.visible[k] = s.buttons[k]
          }
        }
        if (Array.isArray(s.scaleLevels) && s.scaleLevels.length) p.values.scaleLevels = s.scaleLevels
        if (Array.isArray(s.sensLevels) && s.sensLevels.length) p.values.sensLevels = s.sensLevels
        if (Array.isArray(s.speedLevels) && s.speedLevels.length) p.values.speedLevels = s.speedLevels
        // Reprend l'ÉTAT ACTIF de cet appareil (anciennes clés reader_<k>_<uid>) → pas de perte.
        ensureState(p)
        if (typeof s.autoEdgePause === 'number' && s.autoEdgePause > 0) p.state.pause = s.autoEdgePause
        const u = uid || 'anon'
        const g = (k) => localStorage.getItem(`reader_${k}_${u}`)
        p.state.scrollnav = g('scrollnav') === '1'
        const zp = Number(g('zoompct')); if (zp >= 40 && zp <= 100) p.state.scale = zp
        store.profiles.perso = p
        store.defaultId = 'perso'; store.activeId = 'perso'
      }
    } catch { /* noop */ }
    try { await api.setReaderProfiles(store) } catch { /* noop */ }
  }
  store.perManga = store.perManga || {}
  Object.values(store.profiles).forEach(ensureState)   // garantit un `state` complet partout
  return store
}

export async function saveProfiles(store) {
  try { await api.setReaderProfiles(store) } catch { /* noop */ }
}

// Profil résolu pour un manga : override perManga → defaultId → default.
export function resolveProfileId(store, mangaId) {
  return (mangaId && store.perManga && store.perManga[mangaId]) || store.defaultId || 'default'
}

export function getProfile(store, id) {
  const p = (store && store.profiles && store.profiles[id]) || store.profiles.default || makeProfile('default', 'Default')
  return ensureState(p)
}
