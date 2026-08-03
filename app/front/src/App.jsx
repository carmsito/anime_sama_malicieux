import React, { useContext, useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Home from './pages/Home'
import MangaDetail from './pages/MangaDetail'
import EpubReader from './pages/EpubReader'
import Users from './pages/Users'
import Stats from './pages/Stats'
import Navbar from './components/Navbar'
import JobStatus from './components/JobStatus'
import PageErrorBoundary from './components/PageErrorBoundary'
import { AuthCtx, JobsCtx, SearchCtx } from './contexts'
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
  const addJob = (j) => setJobs((p) => [j, ...p.filter((x) => x.id !== j.id)])
  const updateJob = (id, u) => setJobs((p) => p.map((j) => (j.id === id ? { ...j, ...u } : j)))
  const dismissJob = (id) => setJobs((p) => p.filter((j) => j.id !== id))
  return { jobs, addJob, updateJob, dismissJob }
}

function Guard({ children }) {
  const { user } = useContext(AuthCtx)
  return user ? children : <Navigate to="/login" replace />
}

export default function App() {
  const auth = useAuth()
  const jobs = useJobs()
  const [searchQuery, setSearchQuery] = useState('')

  return (
    <AuthCtx.Provider value={auth}>
      <JobsCtx.Provider value={jobs}>
        <SearchCtx.Provider value={{ query: searchQuery, set: setSearchQuery }}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/manga/:mangaId/read/:chapterNum" element={<Guard><EpubReader /></Guard>} />
            <Route path="/*" element={
              <Guard>
                <PageErrorBoundary>
                  <Navbar />
                  <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/manga/:mangaId" element={<MangaDetail />} />
                    <Route path="/stats" element={<Stats />} />
                    <Route path="/admin/users" element={<Users />} />
                  </Routes>
                  <JobStatus />
                </PageErrorBoundary>
              </Guard>
            } />
          </Routes>
        </SearchCtx.Provider>
      </JobsCtx.Provider>
    </AuthCtx.Provider>
  )
}
