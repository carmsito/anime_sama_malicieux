import React, { useEffect, useState, useContext } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { AuthCtx } from '../contexts'

const UNIT_LABELS = { day: 'jour', week: 'semaine', month: 'mois' }

function Maintenance() {
  const [st, setSt] = useState(null)
  const [enabled, setEnabled] = useState(false)
  const [unit, setUnit] = useState('week')
  const [count, setCount] = useState(1)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)

  const load = () => api.getScenarios().then((r) => {
    const v = r.verification
    setSt(v)
    setEnabled(v.conf.enabled); setUnit(v.conf.unit); setCount(v.conf.count)
  }).catch(() => {})

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)   // rafraîchit l'état (job en cours / résultats)
    return () => clearInterval(t)
  }, [])

  const save = async () => {
    setSaving(true)
    try { await api.setVerification(enabled, unit, count); await load() }
    finally { setSaving(false) }
  }
  const runNow = async () => {
    setRunning(true)
    try { await api.runVerification(); setTimeout(load, 1500) }
    finally { setRunning(false) }
  }

  const res = st?.result
  const fmt = (iso) => iso ? new Date(iso).toLocaleString('fr-FR') : '—'

  return (
    <div className="maint-panel">
      <div className="maint-head">
        <div>
          <div className="maint-title">Maintenance — Vérification d'intégrité</div>
          <div className="maint-sub">Détecte les EPUB cassés/tronqués sur Telegram (par source).</div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={runNow} disabled={running || st?.running}>
          {(running || st?.running)
            ? <><span className="spin" style={{ width: 13, height: 13 }} /> En cours…</>
            : <><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg> Lancer maintenant</>}
        </button>
      </div>

      {/* Programmation */}
      <div className="maint-config">
        <label className="maint-toggle">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Programmé</span>
        </label>
        <span className="maint-freq">
          <input type="number" min="1" max="100" value={count}
            onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} disabled={!enabled} />
          fois par
          <select value={unit} onChange={(e) => setUnit(e.target.value)} disabled={!enabled}>
            <option value="day">jour</option>
            <option value="week">semaine</option>
            <option value="month">mois</option>
          </select>
        </span>
        <button className="btn btn-ghost btn-sm" onClick={save} disabled={saving}>
          {saving ? '…' : 'Enregistrer'}
        </button>
      </div>

      <div className="maint-meta">
        Dernier passage : <b>{fmt(st?.conf?.last_run)}</b>
        {enabled && <> · Prochain : <b>{fmt(st?.conf?.next_run)}</b></>}
      </div>

      {/* Résultats */}
      {res && res.ts && (
        <div className="maint-results">
          <div className="maint-results-top">
            <span>{res.checked} EPUB vérifiés</span>
            <span className={res.broken?.length ? 'maint-bad' : 'maint-good'}>
              {res.broken?.length ? `${res.broken.length} cassé(s)` : 'Tout est sain ✓'}
            </span>
          </div>
          {res.broken?.length > 0 && (
            <>
              <div className="maint-bysrc">
                {Object.entries(res.by_source || {}).map(([s, n]) => (
                  <span key={s} className="maint-src-chip">{s} : {n}</span>
                ))}
              </div>
              <div className="maint-broken-list">
                {res.broken.slice(0, 40).map((b, i) => (
                  <div key={i} className="maint-broken-row">
                    <span className="maint-broken-name">{b.manga_name}</span>
                    <span className="maint-broken-ch">{b.kind} {b.chapter_number}</span>
                    <span className="maint-broken-src">{b.source}</span>
                  </div>
                ))}
              </div>
              <div className="maint-hint">→ Ouvre l'œuvre concernée et utilise « Réparer » (icône clé) pour re-scraper ces éléments.</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function Users() {
  const { user } = useContext(AuthCtx)
  const navigate = useNavigate()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [nu, setNu] = useState({ username: '', password: '', role: 'scrapper' })
  const [creating, setCreating] = useState(false)

  const load = () => {
    setLoading(true)
    api.listUsers().then(setUsers).catch(e => setErr(e.message)).finally(() => setLoading(false))
  }

  useEffect(() => {
    if (user && user.role !== 'admin') { navigate('/'); return }
    load()
  }, [user]) // eslint-disable-line

  const onCreate = async (e) => {
    e.preventDefault()
    setErr(''); setCreating(true)
    try {
      await api.createUser(nu.username.trim(), nu.password, nu.role)
      setNu({ username: '', password: '', role: 'scrapper' })
      load()
    } catch (e) { setErr(e.message) } finally { setCreating(false) }
  }

  const onRole = async (u, role) => {
    try { await api.setUserRole(u.id, role); load() } catch (e) { setErr(e.message) }
  }
  const onDelete = async (u) => {
    if (!confirm(`Supprimer ${u.username} ?`)) return
    try { await api.deleteUser(u.id); load() } catch (e) { setErr(e.message) }
  }

  return (
    <div className="page users-page">
      <div className="users-head">
        <button className="detail-back" onClick={() => navigate('/')}>←</button>
        <h1>Utilisateurs</h1>
      </div>

      {err && <div className="err-msg" style={{ marginBottom: '1rem' }}>{err}</div>}

      <Maintenance />

      <h2 className="users-subtitle">Utilisateurs</h2>
      {/* Création */}
      <form className="user-create" onSubmit={onCreate}>
        <input placeholder="Nom d'utilisateur" value={nu.username}
          onChange={e => setNu({ ...nu, username: e.target.value })} required />
        <input type="password" placeholder="Mot de passe" value={nu.password}
          onChange={e => setNu({ ...nu, password: e.target.value })} required />
        <select value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })}>
          <option value="lecteur">lecteur</option>
          <option value="scrapper">scrapper</option>
          <option value="admin">admin</option>
        </select>
        <button className="btn btn-primary btn-sm" disabled={creating}>
          {creating ? '…' : 'Ajouter'}
        </button>
      </form>

      {/* Liste */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}><div className="spin" /></div>
      ) : (
        <div className="user-list">
          {users.map(u => (
            <div className="user-row" key={u.id}>
              <div className="user-info">
                <span className="user-name">{u.username}</span>
                <span className={`user-badge ${u.role}`}>{u.role}</span>
              </div>
              <div className="user-actions">
                <select value={u.role} onChange={e => onRole(u, e.target.value)}
                  disabled={u.id === user?.id}>
                  <option value="lecteur">lecteur</option>
                  <option value="scrapper">scrapper</option>
                  <option value="admin">admin</option>
                </select>
                <button className="btn btn-ghost btn-sm" onClick={() => onDelete(u)}
                  disabled={u.id === user?.id}>Supprimer</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
