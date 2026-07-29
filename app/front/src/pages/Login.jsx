import React, { useState, useContext } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { AuthCtx } from '../contexts'

export default function Login() {
  const { login } = useContext(AuthCtx)
  const navigate = useNavigate()
  const [mode, setMode] = useState('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault(); setLoading(true); setErr('')
    try {
      const res = mode === 'login'
        ? await api.login(username, password)
        : await api.register(username, password)
      login(res.user, res.access_token)
      navigate('/')
    } catch (e) { setErr(e.message) }
    finally { setLoading(false) }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo-txt">MANGALIB</div>
        <div className="login-h">{mode === 'login' ? 'Connexion' : 'Inscription'}</div>
        {err && <div className="err-msg">{err}</div>}
        <form onSubmit={submit}>
          <div className="f-field">
            <label>Nom d'utilisateur</label>
            <input autoFocus placeholder="Nom d'utilisateur" value={username}
              onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="f-field">
            <label>Mot de passe</label>
            <input type="password" placeholder="Mot de passe" value={password}
              onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', marginTop: '.5rem', padding: '.85rem', fontSize: '1rem' }}
            disabled={loading}>
            {loading ? <div className="spin" style={{ width: 18, height: 18 }} /> : (mode === 'login' ? 'Se connecter' : "S'inscrire")}
          </button>
        </form>
        <div className="login-switch" style={{ marginTop: '1.25rem', textAlign: 'center', fontSize: '.85rem', color: 'rgba(255,255,255,.5)' }}>
          {mode === 'login'
            ? <>Nouveau ? <button style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontWeight: 700 }} onClick={() => setMode('register')}>Créer un compte</button></>
            : <>Déjà inscrit ? <button style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontWeight: 700 }} onClick={() => setMode('login')}>Se connecter</button></>
          }
        </div>
      </div>
    </div>
  )
}
