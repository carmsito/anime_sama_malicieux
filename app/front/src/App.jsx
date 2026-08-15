import React, { useContext, useState, useEffect, useRef } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Home from './pages/Home'
import MangaDetail from './pages/MangaDetail'
import EpubReader from './pages/EpubReader'
import Users from './pages/Users'
import Stats from './pages/Stats'
import Settings from './pages/Settings'
import Console from './pages/Console'
import TvCast from './pages/TvCast'
import Navbar from './components/Navbar'
import JobStatus from './components/JobStatus'
import ConsoleStatus from './components/ConsoleStatus'
import PageErrorBoundary from './components/PageErrorBoundary'
import { AuthCtx, JobsCtx, SearchCtx, ConsoleCtx, CastCtx } from './contexts'
import { useConsoleSession } from './consoleSession'
import { useCastSession } from './castSession'
import { api } from './api/client'

function useAuth() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('user')) } catch { return null }
  })
  const login = (u, t) => { localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify(u)); setUser(u) }
  const logout = () => { localStorage.removeItem('token'); localStorage.removeItem('user'); setUser(null) }

  // Au chargement, rafraîchit le profil depuis /me (récupère le rôle même pour les
  // sessions ouvertes avant l'ajout des rôles → le lien Admin apparaît sans re-login).
  useEffect(() => {
    if (!localStorage.getItem('token')) return
    api.me().then((u) => {
      setUser(u)
      localStorage.setItem('user', JSON.stringify(u))
    }).catch(() => {})
  }, [])

  return { user, login, logout }
}

function useJobs() {
  const [jobs, setJobs] = useState([])
  const dismissedRef = useRef(new Set())

  // Récupère les jobs du SERVEUR (source de vérité) → survit au F5 + suivi réel.
  // Sans ça, un F5 vidait la liste et on ne voyait plus le job (qui tourne pourtant côté serveur).
  useEffect(() => {
    if (!localStorage.getItem('token')) return
    let stop = false
    const poll = async () => {
      try {
        const server = await api.listJobs()
        if (stop) return
        setJobs((prev) => {
          const dismissed = dismissedRef.current
          const byId = Object.fromEntries(server.map((j) => [j.id, j]))
          const result = []
          const seen = new Set()
          // 1) jobs actifs côté serveur (garde la progression locale si + avancée)
          for (const j of server) {
            if (dismissed.has(j.id)) continue
            if (['pending', 'running'].includes(j.status)) {
              const l = prev.find((p) => p.id === j.id)
              result.push(l && (l.progress || 0) > (j.progress || 0) ? { ...j, progress: l.progress } : j)
              seen.add(j.id)
            }
          }
          // 2) jobs qu'on suivait et qui viennent de finir → garde l'état final jusqu'au dismiss
          for (const p of prev) {
            if (seen.has(p.id) || dismissed.has(p.id)) continue
            const s = byId[p.id]
            if (s && ['done', 'error'].includes(s.status)) { result.push(s); seen.add(p.id) }
            else if (['done', 'error'].includes(p.status)) { result.push(p); seen.add(p.id) }
          }
          return result
        })
      } catch { /* réseau : on garde l'état courant */ }
    }
    poll()
    const t = setInterval(poll, 2500)
    return () => { stop = true; clearInterval(t) }
  }, [])

  const addJob = (j) => setJobs((p) => [j, ...p.filter((x) => x.id !== j.id)])
  const updateJob = (id, u) => setJobs((p) => p.map((j) => (j.id === id ? { ...j, ...u } : j)))
  const dismissJob = (id) => { dismissedRef.current.add(id); setJobs((p) => p.filter((j) => j.id !== id)) }
  return { jobs, addJob, updateJob, dismissJob }
}

function Guard({ children }) {
  const { user } = useContext(AuthCtx)
  return user ? children : <Navigate to="/login" replace />
}

export default function App() {
  const auth = useAuth()
  const jobs = useJobs()
  const consoleSession = useConsoleSession()   // vit au niveau App → survit à la navigation
  const castSession = useCastSession()         // diffusion TV → survit à la navigation (stop explicite only)
  const [searchQuery, setSearchQuery] = useState('')

  return (
    <AuthCtx.Provider value={auth}>
      <JobsCtx.Provider value={jobs}>
        <ConsoleCtx.Provider value={consoleSession}>
        <CastCtx.Provider value={castSession}>
        <SearchCtx.Provider value={{ query: searchQuery, set: setSearchQuery }}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/tv" element={<TvCast />} />
            <Route path="/manga/:mangaId/read/:chapterNum" element={<Guard><EpubReader /></Guard>} />
            <Route path="/*" element={
              <Guard>
                <PageErrorBoundary>
                  <Navbar />
                  <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/manga/:mangaId" element={<MangaDetail />} />
                    <Route path="/stats" element={<Stats />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/admin/users" element={<Users />} />
                    <Route path="/admin/console" element={<Console />} />
                  </Routes>
                  <JobStatus />
                  <ConsoleStatus />
                </PageErrorBoundary>
              </Guard>
            } />
          </Routes>
        </SearchCtx.Provider>
        </CastCtx.Provider>
        </ConsoleCtx.Provider>
      </JobsCtx.Provider>
    </AuthCtx.Provider>
  )
}
