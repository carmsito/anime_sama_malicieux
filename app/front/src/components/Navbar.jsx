import React, { useContext, useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { gsap } from 'gsap'
import { AuthCtx, SearchCtx } from '../contexts'
import SearchModal from './SearchModal'

const APP_NAME = 'MANGALIB'

export default function Navbar() {
  const { user, logout } = useContext(AuthCtx)
  const { set: setSearch } = useContext(SearchCtx)
  const navigate = useNavigate()
  const location = useLocation()
  const [showExtract, setShowExtract] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [burgerOpen, setBurgerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [scrolled, setScrolled] = useState(false)
  const desktopBarRef = useRef()   // inline bar inside nav-actions
  const mobileBarRef = useRef()    // overlay below navbar
  const inputRef = useRef()
  const mobileInputRef = useRef()
  const isHome = location.pathname === '/'

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (searchOpen) closeSearch()
    setBurgerOpen(false)
  }, [location.pathname]) // eslint-disable-line

  const isMobile = () => window.innerWidth <= 768

  const openSearch = () => {
    setSearchOpen(true)
    requestAnimationFrame(() => {
      if (isMobile()) {
        mobileInputRef.current?.focus()
        if (mobileBarRef.current)
          gsap.fromTo(mobileBarRef.current, { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: .22, ease: 'power2.out' })
      } else {
        if (desktopBarRef.current)
          gsap.fromTo(desktopBarRef.current, { width: 0, opacity: 0 }, { width: 240, opacity: 1, duration: .3, ease: 'power3.out' })
        setTimeout(() => inputRef.current?.focus(), 50)
      }
    })
  }

  const closeSearch = () => {
    const doClose = () => { setSearchOpen(false); setQuery(''); setSearch('') }
    if (isMobile()) {
      if (!mobileBarRef.current) { doClose(); return }
      gsap.to(mobileBarRef.current, { opacity: 0, y: -6, duration: .18, ease: 'power2.in', onComplete: doClose })
    } else {
      if (!desktopBarRef.current) { doClose(); return }
      gsap.to(desktopBarRef.current, { width: 0, opacity: 0, duration: .22, ease: 'power2.in', onComplete: doClose })
    }
  }

  const onQueryChange = (e) => {
    const v = e.target.value
    setQuery(v)
    setSearch(v)
    if (!isHome) navigate('/')
  }

  const onKeyDown = (e) => { if (e.key === 'Escape') closeSearch() }

  const SearchIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )

  return (
    <>
      <nav className={`navbar ${scrolled || searchOpen ? 'scrolled' : ''}`}>

        {/* ── Burger (mobile only) ── */}
        <button className="nav-burger" onClick={() => setBurgerOpen((o) => !o)}>
          {burgerOpen
            ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          }
        </button>

        {/* ── Logo ── */}
        <div className="nav-logo" onClick={() => navigate('/')}>{APP_NAME}</div>

        {isHome && <div className="nav-links"><span className="nav-link active">Bibliothèque</span></div>}
        <div className="nav-spacer" />

        {/* ── Desktop actions (hidden on mobile) ── */}
        <div className="nav-actions">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {searchOpen && (
              <div ref={desktopBarRef} style={{
                display: 'flex', alignItems: 'center', gap: '.4rem',
                background: 'rgba(0,0,0,.75)', border: '1px solid rgba(255,255,255,.5)',
                padding: '.38rem .75rem', overflow: 'hidden', width: 0, opacity: 0,
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ color: 'rgba(255,255,255,.7)', flexShrink: 0 }}>
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input ref={inputRef} value={query} onChange={onQueryChange} onKeyDown={onKeyDown}
                  placeholder="Titres, auteurs…"
                  style={{ background: 'none', border: 'none', outline: 'none', color: '#fff', fontSize: '.88rem', width: '100%', fontFamily: 'inherit' }}
                />
                {query && (
                  <button onClick={() => { setQuery(''); setSearch(''); inputRef.current?.focus() }}
                    style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.5)', cursor: 'pointer', fontSize: '.8rem', flexShrink: 0 }}>✕</button>
                )}
              </div>
            )}
            <button className="nav-icon-btn" onClick={searchOpen ? closeSearch : openSearch} title="Rechercher">
              <SearchIcon />
            </button>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setShowExtract(true)}>+ Extraire</button>
          {user && <span className="nav-user-label">{user.username}</span>}
          <button className="btn btn-ghost btn-sm" onClick={logout}>Déconnexion</button>
        </div>

        {/* ── Mobile right: loupe only ── */}
        <div className="nav-mobile-right">
          <button className="nav-icon-btn" onClick={searchOpen ? closeSearch : openSearch} title="Rechercher">
            <SearchIcon />
          </button>
        </div>
      </nav>

      {/* ── Mobile search overlay (below navbar) ── */}
      {searchOpen && (
        <div ref={mobileBarRef} className="nav-search-overlay">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ color: 'rgba(255,255,255,.6)', flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input ref={mobileInputRef} value={query} onChange={onQueryChange} onKeyDown={onKeyDown}
            placeholder="Titres, auteurs…" autoFocus
            style={{ background: 'none', border: 'none', outline: 'none', color: '#fff', fontSize: '.9rem', width: '100%', fontFamily: 'inherit' }}
          />
          {query && (
            <button onClick={() => { setQuery(''); setSearch(''); mobileInputRef.current?.focus() }}
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.5)', cursor: 'pointer', fontSize: '.85rem', flexShrink: 0 }}>✕</button>
          )}
          <button onClick={closeSearch}
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.4)', cursor: 'pointer', fontSize: '.8rem', flexShrink: 0, padding: '.2rem .4rem' }}>Fermer</button>
        </div>
      )}

      {/* ── Burger dropdown (mobile) ── */}
      {burgerOpen && (
        <div className="nav-burger-menu">
          <button className="nav-burger-item" onClick={() => { setShowExtract(true); setBurgerOpen(false) }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
            </svg>
            Extraire
          </button>
          <button className="nav-burger-item nav-burger-logout" onClick={() => { logout(); setBurgerOpen(false) }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Déconnexion
          </button>
        </div>
      )}

      {showExtract && <SearchModal onClose={() => setShowExtract(false)} />}
    </>
  )
}
