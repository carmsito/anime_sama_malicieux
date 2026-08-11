// Profils de lecture — SYNCHRONISÉS PAR COMPTE (backend), donc multi-appareils, sans
// gestion de cache locale. Un profil = quelles options sont VISIBLES + leurs VALEURS
// autorisées + les DÉFAUTS + le geste de zoom. Le profil `default` est éditable mais
// non supprimable (fallback, tout activé au départ).
import { api } from './api/client'
import { DEFAULTS } from './readerSettings'

// Options togglables dans un profil (le plein écran reste TOUJOURS visible, hors liste).
export const OPTION_KEYS = [
  { key: 'scrollnav', label: 'Navigation à la molette' },
  { key: 'fitwidth', label: 'Mode défilement (fit largeur)' },
  { key: 'flip', label: 'Animation page qui se tourne' },
  { key: 'autoscroll', label: 'Défilement auto + vitesse' },   // auto-scroll ⇄ vitesse : liés
  { key: 'scale', label: "Taille de la planche (échelle)" },
  { key: 'sensitivity', label: 'Sensibilité de déplacement en zoom' },
]

export const ZOOM_GESTURES = [
  ['doubletap', 'Double-tap'], ['pinch', 'Pincement'], ['both', 'Les deux'],
]

export function makeProfile(id, name, allVisible = true) {
  return {
    id,
    name,
    visible: {
      scrollnav: allVisible, fitwidth: allVisible, flip: allVisible,
      autoscroll: allVisible, scale: allVisible, sensitivity: allVisible,
    },
    values: {
      scaleLevels: [...DEFAULTS.scaleLevels],
      sensLevels: [...DEFAULTS.sensLevels],
      speedLevels: [...DEFAULTS.speedLevels],
    },
    defaults: {
      fitwidth: false, flip: false, scale: 100, sens: 1,
      autoscroll: false, speed: DEFAULTS.speedLevels[3] || 70, autoEdgePause: 0,
    },
    zoomGesture: 'both',
  }
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
        if (typeof s.autoEdgePause === 'number') p.defaults.autoEdgePause = s.autoEdgePause
        store.profiles.perso = p
        store.defaultId = 'perso'; store.activeId = 'perso'
      }
    } catch { /* noop */ }
    try { await api.setReaderProfiles(store) } catch { /* noop */ }
  }
  store.perManga = store.perManga || {}
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
  return (store && store.profiles && store.profiles[id]) || store.profiles.default || makeProfile('default', 'Default')
}
