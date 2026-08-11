import React, { useContext, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AuthCtx } from '../contexts'
import { SCALE_CHOICES, SENS_CHOICES, SPEED_CHOICES } from '../readerSettings'
import {
  OPTION_KEYS, ZOOM_GESTURES, makeProfile, loadProfiles, saveProfiles,
} from '../readerProfiles'

function Toggle({ on, onChange, label }) {
  return (
    <label className="set-toggle">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

function ChipMulti({ choices, selected, onToggle, fmt }) {
  return (
    <div className="set-chips">
      {choices.map((c) => (
        <button key={c} type="button"
          className={`set-chip ${selected.includes(c) ? 'on' : ''}`}
          onClick={() => onToggle(c)}>
          {fmt ? fmt(c) : c}
        </button>
      ))}
    </div>
  )
}

export default function Settings() {
  const { user } = useContext(AuthCtx)
  const uid = user?.id || 'anon'
  const navigate = useNavigate()
  const [store, setStore] = useState(null)
  const [sel, setSel] = useState('default')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    loadProfiles(uid).then((st) => { setStore(st); setSel(st.defaultId || 'default') })
  }, [uid])

  if (!store) {
    return (
      <div className="page settings-page">
        <div className="users-head">
          <button className="detail-back" onClick={() => navigate(-1)}>←</button>
          <h1>Profils de lecture</h1>
        </div>
        <p style={{ color: 'var(--text2)' }}>Chargement…</p>
      </div>
    )
  }

  const prof = store.profiles[sel] || store.profiles.default
  const isDefault = sel === 'default'

  const patchProfile = (p) => {
    setStore((prev) => ({ ...prev, profiles: { ...prev.profiles, [sel]: { ...prev.profiles[sel], ...p } } }))
    setSaved(false)
  }
  const setVisible = (k, v) => patchProfile({ visible: { ...prof.visible, [k]: v } })
  const toggleValue = (field, choices, val) => {
    const cur = prof.values[field]
    let next = cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val]
    if (!next.length) return
    next = choices.filter((c) => next.includes(c))
    patchProfile({ values: { ...prof.values, [field]: next } })
  }

  const newProfile = () => {
    const id = 'p' + Date.now().toString(36)
    setStore((prev) => ({ ...prev, profiles: { ...prev.profiles, [id]: makeProfile(id, 'Nouveau profil', true) } }))
    setSel(id); setSaved(false)
  }
  const duplicate = () => {
    const id = 'p' + Date.now().toString(36)
    const p = JSON.parse(JSON.stringify(prof)); p.id = id; p.name = `${prof.name} (copie)`
    setStore((prev) => ({ ...prev, profiles: { ...prev.profiles, [id]: p } }))
    setSel(id); setSaved(false)
  }
  const rename = () => {
    const name = window.prompt('Nom du profil', prof.name)
    if (name && name.trim()) patchProfile({ name: name.trim() })
  }
  const remove = () => {
    if (isDefault) return
    if (!window.confirm(`Supprimer le profil « ${prof.name} » ?`)) return
    setStore((prev) => {
      const profiles = { ...prev.profiles }; delete profiles[sel]
      const perManga = { ...prev.perManga }
      Object.keys(perManga).forEach((k) => { if (perManga[k] === sel) delete perManga[k] })
      return { ...prev, profiles, perManga, defaultId: prev.defaultId === sel ? 'default' : prev.defaultId }
    })
    setSel('default'); setSaved(false)
  }
  const setAsDefault = () => { setStore((prev) => ({ ...prev, defaultId: sel })); setSaved(false) }

  const save = async () => { await saveProfiles(store); setSaved(true) }

  return (
    <div className="page settings-page">
      <div className="users-head">
        <button className="detail-back" onClick={() => navigate(-1)}>←</button>
        <h1>Profils de lecture</h1>
      </div>
      <p style={{ color: 'var(--text2)', margin: '.2rem 0 1.2rem', fontSize: '.9rem' }}>
        Chaque profil décide quelles options sont visibles dans le lecteur et leurs valeurs.
        Synchronisés sur ton compte (multi-appareils). Choisis le profil d'un manga via l'icône ⚙️ du lecteur ou le bouton profil sur sa fiche.
      </p>

      {/* Sélecteur de profil */}
      <div className="set-panel">
        <div className="set-title">Profil</div>
        <div className="set-inline" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
          <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ width: 'auto', minWidth: 160 }}>
            {Object.values(store.profiles).map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.id === store.defaultId ? ' ★' : ''}</option>
            ))}
          </select>
          <button className="btn btn-ghost btn-sm" onClick={newProfile}>+ Nouveau</button>
          <button className="btn btn-ghost btn-sm" onClick={duplicate}>Dupliquer</button>
          <button className="btn btn-ghost btn-sm" onClick={rename}>Renommer</button>
          <button className="btn btn-ghost btn-sm" onClick={setAsDefault} disabled={sel === store.defaultId}>
            {sel === store.defaultId ? '★ Par défaut' : 'Définir par défaut'}
          </button>
          <button className="btn btn-danger btn-sm" onClick={remove} disabled={isDefault}>Supprimer</button>
        </div>
        {isDefault && <div className="set-hint" style={{ marginTop: '.4rem' }}>Le profil « Default » ne peut pas être supprimé (secours), mais reste éditable.</div>}
      </div>

      {/* Options visibles */}
      <div className="set-panel">
        <div className="set-title">Options affichées dans le lecteur (⚙️)</div>
        <div className="set-hint">Le plein écran reste toujours visible.</div>
        <div className="set-toggles">
          {OPTION_KEYS.map((o) => (
            <Toggle key={o.key} label={o.label} on={!!prof.visible[o.key]} onChange={(v) => setVisible(o.key, v)} />
          ))}
        </div>
      </div>

      {/* Geste de zoom */}
      <div className="set-panel">
        <div className="set-title">Geste de zoom</div>
        <div className="set-chips">
          {ZOOM_GESTURES.map(([v, label]) => (
            <button key={v} type="button" className={`set-chip ${prof.zoomGesture === v ? 'on' : ''}`}
              onClick={() => patchProfile({ zoomGesture: v })}>{label}</button>
          ))}
        </div>
      </div>

      {/* Vitesses (défilement auto) */}
      <div className="set-panel">
        <div className="set-title">Vitesses de défilement auto (px/s)</div>
        <div className="set-hint">Proposées par le bouton vitesse (si le défilement auto est visible).</div>
        <ChipMulti choices={SPEED_CHOICES} selected={prof.values.speedLevels}
          onToggle={(v) => toggleValue('speedLevels', SPEED_CHOICES, v)} />
      </div>

      {/* Échelle */}
      <div className="set-panel">
        <div className="set-title">Tailles de planche (échelle)</div>
        <div className="set-hint">Proposées par le bouton échelle (100 % = ajusté largeur).</div>
        <ChipMulti choices={SCALE_CHOICES} selected={prof.values.scaleLevels} fmt={(c) => `${c}%`}
          onToggle={(v) => toggleValue('scaleLevels', SCALE_CHOICES, v)} />
      </div>

      {/* Sensibilité */}
      <div className="set-panel">
        <div className="set-title">Sensibilité de déplacement en zoom</div>
        <ChipMulti choices={SENS_CHOICES} selected={prof.values.sensLevels} fmt={(c) => `×${c}`}
          onToggle={(v) => toggleValue('sensLevels', SENS_CHOICES, v)} />
      </div>

      <div className="set-actions">
        <button className="btn btn-primary btn-sm" onClick={save}>{saved ? 'Enregistré ✓' : 'Enregistrer'}</button>
      </div>
      <p style={{ color: 'var(--text3)', fontSize: '.78rem', marginTop: '.8rem' }}>
        Rouvre un chapitre pour appliquer les changements.
      </p>
    </div>
  )
}
