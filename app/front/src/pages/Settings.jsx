import React, { useContext, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AuthCtx } from '../contexts'
import { SCALE_CHOICES, SENS_CHOICES, SPEED_MULT_CHOICES, PAUSE_CHOICES } from '../readerSettings'
import { OPTION_KEYS, makeProfile, loadProfiles, saveProfiles } from '../readerProfiles'

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

// Éditeur de valeurs : chips sélectionnées (cliquer = retirer) + presets à ajouter + ajout d'une
// valeur CUSTOM. Sert aux vitesses (× multiplicateur) et aux temps de pause.
function ValueChips({ presets, selected, onChange, fmt, min, max, step }) {
  const [val, setVal] = useState('')
  const sorted = [...selected].sort((a, b) => a - b)
  const add = (n) => {
    if (Number.isNaN(n) || n < min || n > max) return
    if (selected.some((x) => Math.abs(x - n) < 1e-9)) return
    onChange([...selected, n].sort((a, b) => a - b))
  }
  const remove = (n) => { if (selected.length > 1) onChange(selected.filter((x) => x !== n)) }
  return (
    <div>
      <div className="set-chips">
        {sorted.map((c) => (
          <button key={c} type="button" className="set-chip on" title="Retirer" onClick={() => remove(c)}>
            {fmt ? fmt(c) : c} ✕
          </button>
        ))}
      </div>
      <div className="set-chips" style={{ marginTop: '.4rem' }}>
        {presets.filter((p) => !selected.some((x) => Math.abs(x - p) < 1e-9)).map((p) => (
          <button key={p} type="button" className="set-chip" onClick={() => add(p)}>+ {fmt ? fmt(p) : p}</button>
        ))}
      </div>
      <div className="set-inline" style={{ marginTop: '.5rem', gap: '.4rem' }}>
        <input type="number" value={val} min={min} max={max} step={step} placeholder="valeur perso…"
          onChange={(e) => setVal(e.target.value)} style={{ width: 120 }}
          onKeyDown={(e) => { if (e.key === 'Enter') { add(Number(val)); setVal('') } }} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { add(Number(val)); setVal('') }}>Ajouter</button>
      </div>
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
        <div className="set-hint">Le mode « mise à l'échelle » et le plein écran sont toujours présents.</div>
        <div className="set-toggles">
          {OPTION_KEYS.map((o) => (
            <Toggle key={o.key} label={o.label} on={!!prof.visible[o.key]} onChange={(v) => setVisible(o.key, v)} />
          ))}
        </div>
      </div>

      {/* Échelle */}
      <div className="set-panel">
        <div className="set-title">Tailles de planche (échelle)</div>
        <div className="set-hint">Proposées par les chips (100 % = ajusté largeur). Le pincement zoome librement au-delà.</div>
        <ChipMulti choices={SCALE_CHOICES} selected={prof.values.scaleLevels} fmt={(c) => `${c}%`}
          onToggle={(v) => toggleValue('scaleLevels', SCALE_CHOICES, v)} />
      </div>

      {/* Vitesses (multiplicateurs) — ajout de valeurs custom possible */}
      <div className="set-panel">
        <div className="set-title">Vitesses de défilement auto (× multiplicateur)</div>
        <div className="set-hint">Proposées par le contrôle de vitesse. Ajoute tes propres multiplicateurs (0.1 → 10).</div>
        <ValueChips presets={SPEED_MULT_CHOICES} selected={prof.values.speedMults} fmt={(c) => `×${c}`}
          min={0.1} max={10} step={0.25} onChange={(next) => patchProfile({ values: { ...prof.values, speedMults: next } })} />
      </div>

      {/* Temps de pause entre planches — ajout de valeurs custom possible */}
      <div className="set-panel">
        <div className="set-title">Temps de pause entre planches (s)</div>
        <div className="set-hint">Proposés dans le lecteur (auto-scroll). Ajoute tes propres durées (0 → 30 s).</div>
        <ValueChips presets={PAUSE_CHOICES} selected={prof.values.pauseLevels} fmt={(c) => (c === 0 ? 'Aucune' : `${c}s`)}
          min={0} max={30} step={0.5} onChange={(next) => patchProfile({ values: { ...prof.values, pauseLevels: next } })} />
      </div>

      {/* Sensibilité de déplacement (loupe double-tap) */}
      <div className="set-panel">
        <div className="set-title">Sensibilité de déplacement en zoom (double-tap)</div>
        <div className="set-hint">Vitesse de déplacement de la loupe quand tu as double-tapé.</div>
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
