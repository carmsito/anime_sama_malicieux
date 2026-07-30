import React, { useEffect, useState, useContext } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { AuthCtx } from '../contexts'

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

      {/* Création */}
      <form className="user-create" onSubmit={onCreate}>
        <input placeholder="Nom d'utilisateur" value={nu.username}
          onChange={e => setNu({ ...nu, username: e.target.value })} required />
        <input type="password" placeholder="Mot de passe" value={nu.password}
          onChange={e => setNu({ ...nu, password: e.target.value })} required />
        <select value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })}>
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
