import React, { useContext, useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { gsap } from 'gsap'
import { AuthCtx, SearchCtx } from '../App'
import SearchModal from './SearchModal'

const APP_NAME = 'MANGALIB'

export default function Navbar() {
  const { user, logout } = useContext(AuthCtx)
  const { set: setSearch } = useContext(SearchCtx)
  const navigate = useNavigate()
  const location = useLocation()
  const [showExtract, setShowExtract] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [scrolled, setScrolled] = useState(false)
  const searchBarRef = useRef()
  const inputRef = useRef()
  const isHome = location.pathname === '/'

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Close search on route change
  useEffect(() => {
    if (searchOpen) closeSearch()
  }, [location.pathname]) // eslint-disable-line

  const openSearch = () => {
    setSearchOpen(true)
    requestAnimationFrame(() => {
      if (!searchBarRef.current) return
      gsap.fromTo(searchBarRef.current,
        { width: 0, opacity: 0 },
        { width: 240, opacity: 1, duration: .3, ease: 'power3.out' }
      )
      setTimeout(() => inputRef.current?.focus(), 50)
    })
  }

  const closeSearch = () => {
    if (!searchBarRef.current) { setSearchOpen(false); setQuery(''); setSearch(''); return }
    gsap.to(searchBarRef.current, {
      width: 0, opacity: 0, duration: .22, ease: 'power2.in',
      onComplete: () => { setSearchOpen(false); setQuery(''); setSearch('') }
    })
  }

  const onQueryChange = (e) => {
    const v = e.target.value
    setQuery(v)
    setSearch(v)
    if (!isHome) navigate('/')
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') closeSearch()
  }

  return (
    <>
      <nav className={`navbar ${scrolled || searchOpen ? 'scrolled' : ''}`}>
        <div className="nav-logo" onClick={() => navigate('/')}>{APP_NAME}</div>

        {isHome && (
          <div className="nav-links">
            <span className="nav-link active">Bibliothèque</span>
          </div>
        )}

        <div className="nav-spacer" />

        <div className="nav-actions">
          {/* Netflix-style animated search */}
          <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
            {searchOpen && (
              <div
                ref={searchBarRef}
                style={{
                  display: 'flex', alignItems: 'center', gap: '.4rem',
                  background: 'rgba(0,0,0,.75)', border: '1px solid rgba(255,255,255,.5)',
                  padding: '.38rem .75rem', overflow: 'hidden',
                  width: 0, opacity: 0,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ color: 'rgba(255,255,255,.7)', flexShrink: 0 }}>
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={onQueryChange}
                  onKeyDown={onKeyDown}
                  placeholder="Titres, auteurs…"
                  style={{
                    background: 'none', border: 'none', outline: 'none',
                    color: '#fff', fontSize: '.88rem', width: '100%',
                    fontFamily: 'inherit',
                  }}
                />
                {query && (
                  <button onClick={() => { setQuery(''); setSearch(''); inputRef.current?.focus() }}
                    style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.5)', cursor: 'pointer', fontSize: '.8rem', flexShrink: 0 }}>
                    ✕
                  </button>
                )}
              </div>
            )}

            <button
              onClick={searchOpen ? closeSearch : openSearch}
              style={{
                background: 'none', border: 'none', color: '#fff', cursor: 'pointer',
                padding: '.4rem', display: 'flex', alignItems: 'center',
              }}
              title="Rechercher"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </button>
          </div>

          <button className="btn btn-primary btn-sm" onClick={() => setShowExtract(true)}>
            + Extraire
          </button>
          {user && <span className="nav-user-label">{user.username}</span>}
          <button className="btn btn-ghost btn-sm" onClick={logout}>Déconnexion</button>
        </div>
      </nav>

      {showExtract && <SearchModal onClose={() => setShowExtract(false)} />}
    </>
  )
}
