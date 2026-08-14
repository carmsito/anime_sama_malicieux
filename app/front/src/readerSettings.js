// Réglages du lecteur, PAR UTILISATEUR (localStorage, clé préfixée par l'id).
// Permet d'afficher/masquer les boutons, de personnaliser les plages de valeurs
// (échelle, sensibilité, vitesse d'auto-scroll) et la pause de bord de planche.

export const BUTTON_KEYS = [
  { key: 'scrollnav', label: 'Navigation à la molette' },
  { key: 'fitwidth', label: 'Mode défilement (fit largeur)' },
  { key: 'fullscreen', label: 'Plein écran' },
  { key: 'flip', label: 'Animation page qui se tourne' },
  { key: 'autoscroll', label: 'Défilement automatique' },
  { key: 'scale', label: "Taille de la planche (mise à l'échelle)" },
  { key: 'sensitivity', label: 'Sensibilité de déplacement en zoom' },
]

export const SCALE_CHOICES = [40, 50, 60, 70, 80, 90, 100, 125, 150, 200, 250, 300]
export const SENS_CHOICES = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]
export const SPEED_CHOICES = [8, 20, 40, 70, 110, 160, 240, 340]

// Défilement auto : vitesse = BASE × multiplicateur (px/s). L'utilisateur choisit le ×.
export const BASE_AUTO_SPEED = 80
export const SPEED_MULT_CHOICES = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]
// Temps de pause entre les planches (secondes), sélectionnable comme une option du profil.
export const PAUSE_CHOICES = [0, 0.5, 1, 1.5, 2, 3, 5]
// Mode Cinéma auto-lecture : durées d'affichage min (case sans texte) / max (case bavarde), en s.
export const CINE_DWELL_CHOICES = [0.8, 1, 1.5, 2, 3, 4, 5, 7, 10]

export const DEFAULTS = {
  buttons: { scrollnav: true, fitwidth: true, fullscreen: true, flip: true, autoscroll: true, scale: true, sensitivity: true },
  scaleLevels: [50, 70, 100, 150, 200, 300],
  sensLevels: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5],
  speedLevels: [8, 20, 40, 70, 110, 160, 240, 340],
  speedMults: [0.5, 0.75, 1, 1.5, 2, 3],
  pauseLevels: [0, 0.5, 1, 2, 3],
  autoEdgePause: 0,   // secondes de pause en début/fin de planche (auto-scroll)
}

function _sanitizeLevels(arr, choices, fallback) {
  if (!Array.isArray(arr)) return fallback
  const filtered = choices.filter((c) => arr.includes(c))
  return filtered.length ? filtered : fallback
}

export function loadReaderSettings(uid) {
  try {
    const raw = localStorage.getItem(`reader_settings_${uid || 'anon'}`)
    const s = raw ? JSON.parse(raw) : {}
    return {
      buttons: { ...DEFAULTS.buttons, ...(s.buttons || {}) },
      scaleLevels: _sanitizeLevels(s.scaleLevels, SCALE_CHOICES, DEFAULTS.scaleLevels),
      sensLevels: _sanitizeLevels(s.sensLevels, SENS_CHOICES, DEFAULTS.sensLevels),
      speedLevels: _sanitizeLevels(s.speedLevels, SPEED_CHOICES, DEFAULTS.speedLevels),
      autoEdgePause: typeof s.autoEdgePause === 'number' && s.autoEdgePause >= 0 ? Math.min(s.autoEdgePause, 30) : DEFAULTS.autoEdgePause,
    }
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS))
  }
}

export function saveReaderSettings(uid, s) {
  try { localStorage.setItem(`reader_settings_${uid || 'anon'}`, JSON.stringify(s)) } catch { /* noop */ }
}
