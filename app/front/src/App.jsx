import React, { createContext, useContext, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Home from './pages/Home'
import MangaDetail from './pages/MangaDetail'
import EpubReader from './pages/EpubReader'
import Navbar from './components/Navbar'
import JobStatus from './components/JobStatus'

export const AuthCtx = createContext(null)
export const JobsCtx = createContext(null)
export const SearchCtx = createContext({ query: '', set: () => {} })

function useAuth() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('user')) } catch { return null }
  })
  const login = (u, t) => { localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify(u)); setUser(u) }
  const logout = () => { localStorage.removeItem('token'); localStorage.removeItem('user'); setUser(null) }
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
            {/* Reader — standalone, no navbar */}
            <Route path="/manga/:mangaId/read/:chapterNum" element={<Guard><EpubReader /></Guard>} />
            {/* Everything else */}
            <Route path="/*" element={
              <Guard>
                <>
                  <Navbar />
                  <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/manga/:mangaId" element={<MangaDetail />} />
                  </Routes>
                  <JobStatus />
                </>
              </Guard>
            } />
          </Routes>
        </SearchCtx.Provider>
      </JobsCtx.Provider>
    </AuthCtx.Provider>
  )
}
