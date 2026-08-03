import React, { useContext, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AuthCtx } from '../contexts'
import {
  loadReaderSettings, saveReaderSettings, DEFAULTS,
  BUTTON_KEYS, SCALE_CHOICES, SENS_CHOICES, SPEED_CHOICES,
} from '../readerSettings'

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
      {choices.map((c) => {
        const active = selected.includes(c)
        return (
          <button key={c} type="button"
            className={`set-chip ${active ? 'on' : ''}`}
            onClick={() => onToggle(c)}>
            {fmt ? fmt(c) : c}
          </button>
        )
      })}
    </div>
  )
}

export default function Settings() {
  const { user } = useContext(AuthCtx)
  const uid = user?.id || 'anon'
  const navigate = useNavigate()
  const [s, setS] = useState(() => loadReaderSettings(uid))
  const [saved, setSaved] = useState(false)

  const patch = (p) => { setS((prev) => ({ ...prev, ...p })); setSaved(false) }
  const toggleBtn = (k, v) => patch({ buttons: { ...s.buttons, [k]: v } })
  const toggleLevel = (field, choices, val) => {
    const cur = s[field]
    let next = cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val]
    if (!next.length) return               // au moins une valeur
    next = choices.filter((c) => next.includes(c))   // garde l'ordre
    patch({ [field]: next })
  }

  const save = () => { saveReaderSettings(uid, s); setSaved(true) }
  const reset = () => { setS(JSON.parse(JSON.stringify(DEFAULTS))); setSaved(false) }

  return (
    <div className="page settings-page">
      <div className="users-head">
        <button className="detail-back" onClick={() => navigate(-1)}>←</button>
        <h1>Réglages du lecteur</h1>
      </div>
      <p style={{ color: 'var(--text2)', margin: '.2rem 0 1.5rem', fontSize: '.9rem' }}>
        Personnalise tes outils de lecture. Ces réglages sont propres à ton compte.
      </p>

      {/* Boutons visibles */}
      <div className="set-panel">
        <div className="set-title">Boutons affichés dans le lecteur</div>
        <div className="set-toggles">
          {BUTTON_KEYS.map((b) => (
            <Toggle key={b.key} label={b.label} on={!!s.buttons[b.key]} onChange={(v) => toggleBtn(b.key, v)} />
          ))}
        </div>
      </div>

      {/* Défilement auto */}
      <div className="set-panel">
        <div className="set-title">Défilement automatique</div>
        <div className="set-row">
          <span className="set-label">Pause en début/fin de planche</span>
          <div className="set-inline">
            <input type="number" min="0" max="30" step="0.5" value={s.autoEdgePause}
              onChange={(e) => patch({ autoEdgePause: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })} />
            <span className="set-unit">sec</span>
          </div>
        </div>
        <div className="set-hint" style={{ marginTop: '-.3rem' }}>0 = micro-pause par défaut (~0,9 s).</div>
        <div className="set-row">
          <span className="set-label">Vitesses disponibles (px/s)</span>
        </div>
        <ChipMulti choices={SPEED_CHOICES} selected={s.speedLevels}
          onToggle={(v) => toggleLevel('speedLevels', SPEED_CHOICES, v)} />
      </div>

      {/* Mise à l'échelle */}
      <div className="set-panel">
        <div className="set-title">Mise à l'échelle (mode défilement)</div>
        <div className="set-hint">Choisis les tailles proposées par le bouton (100 % = ajusté à la largeur).</div>
        <ChipMulti choices={SCALE_CHOICES} selected={s.scaleLevels} fmt={(c) => `${c}%`}
          onToggle={(v) => toggleLevel('scaleLevels', SCALE_CHOICES, v)} />
      </div>

      {/* Sensibilité */}
      <div className="set-panel">
        <div className="set-title">Sensibilité de déplacement en zoom</div>
        <div className="set-hint">Choisis les niveaux proposés par le bouton.</div>
        <ChipMulti choices={SENS_CHOICES} selected={s.sensLevels} fmt={(c) => `×${c}`}
          onToggle={(v) => toggleLevel('sensLevels', SENS_CHOICES, v)} />
      </div>

      <div className="set-actions">
        <button className="btn btn-ghost btn-sm" onClick={reset}>Réinitialiser</button>
        <button className="btn btn-primary btn-sm" onClick={save}>{saved ? 'Enregistré ✓' : 'Enregistrer'}</button>
      </div>
      <p style={{ color: 'var(--text3)', fontSize: '.78rem', marginTop: '.8rem' }}>
        Rouvre un chapitre pour appliquer les changements.
      </p>
    </div>
  )
}
