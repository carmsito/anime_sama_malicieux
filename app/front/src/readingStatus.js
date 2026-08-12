// Statuts de lecture par utilisateur/manga. Clés stockées côté backend ; libellés + couleurs ici.
export const STATUSES = [
  { key: 'reading',   label: 'En cours',  color: '#2ecc71' },
  { key: 'completed', label: 'Terminé',   color: '#3b82f6' },
  { key: 'on_hold',   label: 'En pause',  color: '#e6a100' },
  { key: 'plan',      label: 'À lire',    color: '#a855f7' },
]

export const STATUS_MAP = Object.fromEntries(STATUSES.map((s) => [s.key, s]))
export const statusLabel = (k) => STATUS_MAP[k]?.label || ''
export const statusColor = (k) => STATUS_MAP[k]?.color || 'rgba(255,255,255,.4)'
