import React, { useState, useEffect, useRef, useCallback, useContext } from 'react'
import { useNavigate } from 'react-router-dom'
import { gsap } from 'gsap'
import { api } from '../api/client'
import { JobsCtx, SearchCtx } from '../contexts'

// ── Manga Card ─────────────────────────────────────────────────────────────

const infoCache = {}

function pluralizeUnit(unit, count) {
  if (count === 1) return unit
  if (unit === 'Chapitre') return 'Chapitres'
  if (unit === 'Volume') return 'Volumes'
  if (unit === 'Tome') return 'Tomes'
  return `${unit}s`
}

function getMangaUnit(manga) {
  return manga?.kind || 'Chapitre'
}

const IS_TOUCH = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches

function MangaCard({ manga, onClick, isNew, isUpdating, favorite = false, percent = 0, onToggleFav, previewing = false, onPreview }) {
  const [imgOk, setImgOk] = useState(!!manga.cover_url)
  const [info, setInfo] = useState(infoCache[manga.id] || null)
  const infoLoadingRef = useRef(false)
  const timerRef = useRef()
  const cardRef = useRef()

  const loadInfo = () => {
    if (info || infoLoadingRef.current) return
    infoLoadingRef.current = true
    api.getMangaInfo(manga.id)
      .then((i) => { infoCache[manga.id] = i; setInfo(i) })
      .catch(() => { })
  }

  useEffect(() => {
    if (isNew && cardRef.current) {
      gsap.fromTo(cardRef.current,
        { opacity: 0, scale: 0.85, y: 20 },
        { opacity: 1, scale: 1, y: 0, duration: 0.5, ease: 'back.out(1.4)' }
      )
    }
  }, [isNew])

  // Mobile : au 1er tap on affiche l'aperçu (tags + description), donc on charge les infos
  useEffect(() => {
    if (previewing) loadInfo()
  }, [previewing]) // eslint-disable-line

  const onEnter = () => {
    // Lazy load info on hover (480ms delay)
    timerRef.current = setTimeout(loadInfo, 480)
  }

  const onLeave = () => {
    clearTimeout(timerRef.current)
  }

  useEffect(() => {
    return () => clearTimeout(timerRef.current)
  }, [])

  // Tactile : 1er tap = aperçu (comme un survol), 2e tap = ouvre. Desktop : clic = ouvre.
  const handleClick = () => {
    if (IS_TOUCH && !previewing) { onPreview?.(); return }
    onClick()
  }

  const genres = info?.genres?.slice(0, 3) || []
  const synopsis = info?.synopsis
  const unit = getMangaUnit(manga)
  const unitShort = unit === 'Chapitre' ? 'chap.' : unit.toLowerCase()

  return (
    <div ref={cardRef} className={`manga-card ${previewing ? 'previewing' : ''}`} onClick={handleClick} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="manga-card-img">
        {imgOk
          ? <img src={manga.cover_url} alt={manga.name} onError={() => setImgOk(false)} />
          : <div className="manga-card-ph">📖</div>
        }
        {isNew && <div className="card-new-badge">Nouveau</div>}
        {isUpdating && (
          <div className="card-loading-badge">
            <div className="spin" style={{ width: 14, height: 14 }} />
            <span>Mise à jour</span>
          </div>
        )}
        <button className={`manga-card-fav ${favorite ? 'on' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleFav?.() }}
          title={favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill={favorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </button>
        {/* Overlay with genres + synopsis (survol desktop, permanent mobile) */}
        <div className="manga-card-overlay-info">
          {genres.length > 0 && (
            <div className="card-genres">
              {genres.map((g) => <span key={g} className="card-genre">{g}</span>)}
            </div>
          )}
          {synopsis && <p className="card-synopsis">{synopsis}</p>}
        </div>
        {percent > 0 && (
          <div className="manga-card-pbar"><div style={{ width: `${percent}%` }} /></div>
        )}
      </div>
      <div className="manga-card-info">
        <div className="manga-card-name">{manga.name}</div>
        <div className="manga-card-cat">
          {manga.chapter_count} {unitShort} · {manga.category}
          {percent > 0 && <>{' · '}<span className="manga-card-cat-pct">{percent}% lu</span></>}
        </div>
      </div>
    </div>
  )
}

// ── Hero Carousel ──────────────────────────────────────────────────────────

const heroCacheInfo = {}

function HeroCarousel({ mangas }) {
  const navigate = useNavigate()
  const [idx, setIdx] = useState(0)
  const [paused, setPaused] = useState(false)
  const bg1 = useRef(); const bg2 = useRef()
  const contentRef = useRef()
  const [activeBg, setActiveBg] = useState(1)
  const [heroInfo, setHeroInfo] = useState(heroCacheInfo[mangas[0]?.id] || null)

  const goTo = useCallback((next) => {
    if (next === idx) return
    // Crossfade between two bg layers
    const incoming = activeBg === 1 ? bg2.current : bg1.current
    const outgoing = activeBg === 1 ? bg1.current : bg2.current
    if (!incoming || !outgoing) return

    const m = mangas[next]
    const bgVal = m.cover_url ? `url(${m.cover_url})` : 'linear-gradient(135deg,#1a0812,#0a0a18)'
    incoming.style.backgroundImage = bgVal
    incoming.style.opacity = 0

    gsap.to(contentRef.current, { opacity: 0, duration: .25 })
    gsap.to(incoming, { opacity: 1, duration: .7, ease: 'power2.inOut' })
    gsap.to(outgoing, {
      opacity: 0, duration: .7, delay: .1, ease: 'power2.inOut',
      onComplete: () => {
        setIdx(next)
        setActiveBg(activeBg === 1 ? 2 : 1)
        gsap.to(contentRef.current, { opacity: 1, duration: .4 })
        // Load info for new slide
        const nextM = mangas[next]
        if (heroCacheInfo[nextM.id]) {
          setHeroInfo(heroCacheInfo[nextM.id])
        } else {
          api.getMangaInfo(nextM.id)
            .then((i) => {
              heroCacheInfo[nextM.id] = i
              setHeroInfo(i)
            })
            .catch(() => { })
        }
      }
    })
  }, [idx, activeBg, mangas])

  useEffect(() => {
    if (paused || mangas.length <= 1) return
    const t = setInterval(() => goTo((idx + 1) % mangas.length), 6000)
    return () => clearInterval(t)
  }, [paused, idx, mangas.length, goTo])

  // Load info on mount for first slide
  useEffect(() => {
    const m = mangas[0]
    if (m && !heroCacheInfo[m.id]) {
      api.getMangaInfo(m.id)
        .then((i) => {
          heroCacheInfo[m.id] = i
          setHeroInfo(i)
        })
        .catch(() => { })
    }
  }, [])

  const m = mangas[idx]
  const bgVal = m.cover_url ? { backgroundImage: `url(${m.cover_url})` } : { background: 'linear-gradient(135deg,#1a0812,#0a0a18)' }
  const genres = heroInfo?.genres?.slice(0, 4) || []
  const synopsis = heroInfo?.synopsis
  const unit = getMangaUnit(m)
  const unitLabel = pluralizeUnit(unit, m.chapter_count).toLowerCase()

  return (
    <div className="hero" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      {/* Two crossfade layers */}
      <div ref={bg1} className="hero-bg" style={bgVal} />
      <div ref={bg2} className="hero-bg" style={{ opacity: 0 }} />
      <div className="hero-fade" />

      {/* Left / Right arrows */}
      {mangas.length > 1 && (
        <>
          <button className="hero-arrow hero-arrow-left"
            onClick={() => goTo((idx - 1 + mangas.length) % mangas.length)}>‹</button>
          <button className="hero-arrow hero-arrow-right"
            onClick={() => goTo((idx + 1) % mangas.length)}>›</button>
        </>
      )}

      <div ref={contentRef} className="hero-body">
        <div className="hero-logo-text">{m.name}</div>
        <div className="hero-sub">{m.category} · {m.chapter_count} {unitLabel}</div>

        {genres.length > 0 && (
          <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', marginBottom: '.8rem' }}>
            {genres.map((g) => (
              <span key={g} style={{
                padding: '.15rem .5rem', borderRadius: 3,
                background: 'rgba(255,255,255,.15)', color: 'rgba(255,255,255,.8)',
                fontSize: '.72rem', fontWeight: 600,
              }}>
                {g}
              </span>
            ))}
          </div>
        )}

        {synopsis && (
          <p style={{
            fontSize: '.9rem', color: 'rgba(255,255,255,.65)', lineHeight: 1.6,
            marginBottom: '.9rem', maxWidth: 500,
            display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden'
          }}>
            {synopsis}
          </p>
        )}

        <div className="hero-btns">
          <button className="btn btn-white" onClick={() => navigate(`/manga/${m.id}`)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            Lire
          </button>
          <button className="btn btn-dark" onClick={() => navigate(`/manga/${m.id}`)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            Détails
          </button>
        </div>
      </div>

      {mangas.length > 1 && (
        <div className="hero-dots">
          {mangas.map((_, i) => (
            <div key={i} className={`hero-dot ${i === idx ? 'active' : ''}`} onClick={() => goTo(i)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Home ───────────────────────────────────────────────────────────────────

export default function Home() {
  const [mangas, setMangas] = useState([])
  const [continueItems, setContinueItems] = useState([])
  const [favItems, setFavItems] = useState([])
  const [favSet, setFavSet] = useState(new Set())
  const [progressMap, setProgressMap] = useState({})
  const [previewId, setPreviewId] = useState(null)  // carte en aperçu (mobile)
  const [loading, setLoading] = useState(true)
  const [newIds, setNewIds] = useState(new Set())
  const [filterOpen, setFilterOpen] = useState(false)
  const [selectedGenres, setSelectedGenres] = useState(new Set())
  const [allGenres, setAllGenres] = useState([])
  const navigate = useNavigate()
  const gridRef = useRef()
  const filterRef = useRef()
  const { query } = useContext(SearchCtx)
  const { jobs } = useContext(JobsCtx)
  const knownIdsRef = useRef(null)
  const knownCountsRef = useRef({})
  const pollRef = useRef()
  const prevJobStatusesRef = useRef({})

  const hasActiveJobForManga = useCallback((manga) => jobs.some((job) => (
    ['pending', 'running'].includes(job.status) &&
    job.manga_name === manga.name &&
    job.source === (manga.source || 'anime-sama') &&
    (job.source !== 'anime-sama' || job.category === manga.category)
  )), [jobs])

  useEffect(() => {
    api.continueReading().then((r) => setContinueItems(r.items || [])).catch(() => {})
    api.listFavorites().then((r) => setFavItems(r.items || [])).catch(() => {})
    api.userStates().then((s) => {
      setFavSet(new Set(s.favorites || []))
      setProgressMap(s.progress || {})
    }).catch(() => {})
  }, [])

  const toggleFav = useCallback(async (mangaId) => {
    const on = !favSet.has(mangaId)
    setFavSet((prev) => {
      const next = new Set(prev)
      if (on) next.add(mangaId); else next.delete(mangaId)
      return next
    })
    try {
      await api.setFavorite(mangaId, on)
      const r = await api.listFavorites()
      setFavItems(r.items || [])
    } catch { /* rollback silencieux au prochain refresh */ }
  }, [favSet])

  useEffect(() => {
    api.listMangas().then((list) => {
      setMangas(list)
      knownIdsRef.current = new Set(list.map((m) => m.id))
      knownCountsRef.current = Object.fromEntries(list.map((m) => [m.id, m.chapter_count]))
    }).catch(console.error).finally(() => setLoading(false))
  }, [])

  // Polling: detect new mangas while a job is running
  useEffect(() => {
    const poll = async () => {
      try {
        const jobs = await api.listJobs()
        const prev = prevJobStatusesRef.current

        // Detect jobs that just transitioned to done (catches fast extractions < 3s)
        const anyJustDone = jobs.some(
          (j) => j.status === 'done' && prev[j.id] !== 'done'
        )
        const anyRunning = jobs.some((j) => j.status === 'running' || j.status === 'pending')

        // Update tracked statuses
        jobs.forEach((j) => { prev[j.id] = j.status })

        if (!anyRunning && !anyJustDone) return

        const list = await api.listMangas()
        const known = knownIdsRef.current
        if (!known) return
        const knownCounts = knownCountsRef.current || {}

        const added = list.filter((m) => !known.has(m.id))
        const updated = list.filter((m) => known.has(m.id) && (knownCounts[m.id] ?? 0) < m.chapter_count)

        if (added.length > 0 || updated.length > 0) {
          added.forEach((m) => known.add(m.id))
          list.forEach((m) => { knownCounts[m.id] = m.chapter_count })

          setNewIds((prev) => {
            const next = new Set(prev)
            added.forEach((m) => next.add(m.id))
            return next
          })
          setMangas(list)

          setTimeout(() => {
            setNewIds((prev) => {
              const next = new Set(prev)
              added.forEach((m) => next.delete(m.id))
              return next
            })
          }, 3000)
        }
      } catch (_) {}
    }

    pollRef.current = setInterval(poll, 3000)
    return () => clearInterval(pollRef.current)
  }, [])

  // Collect all known genres from cache
  useEffect(() => {
    const genres = new Set()
    Object.values(infoCache).forEach((info) => {
      info?.genres?.forEach((g) => genres.add(g))
    })
    setAllGenres([...genres].sort())
  }, [filterOpen])

  // Fetch info for all mangas when filter opens (to populate genre list)
  useEffect(() => {
    if (!filterOpen) return
    mangas.forEach((m) => {
      if (!infoCache[m.id]) {
        api.getMangaInfo(m.id).then((i) => {
          infoCache[m.id] = i
          const genres = new Set()
          Object.values(infoCache).forEach((info) => info?.genres?.forEach((g) => genres.add(g)))
          setAllGenres([...genres].sort())
        }).catch(() => {})
      }
    })
  }, [filterOpen, mangas])

  // Animate filter panel
  useEffect(() => {
    if (!filterRef.current) return
    if (filterOpen) {
      gsap.fromTo(filterRef.current, { opacity: 0, y: -8 }, { opacity: 1, y: 0, duration: .22, ease: 'power2.out' })
    }
  }, [filterOpen])

  const toggleGenre = (g) => {
    setSelectedGenres((prev) => {
      const next = new Set(prev)
      next.has(g) ? next.delete(g) : next.add(g)
      return next
    })
  }

  const recentlyAdded = [...mangas].filter((m) => m.added_at).sort((a, b) => b.added_at - a.added_at).slice(0, 12)

  const filtered = mangas.filter((m) => {
    if (query && !m.name.toLowerCase().includes(query.toLowerCase())) return false
    if (selectedGenres.size > 0) {
      const genres = infoCache[m.id]?.genres || []
      if (!genres.some((g) => selectedGenres.has(g))) return false
    }
    return true
  })

  useEffect(() => {
    if (!filtered.length || !gridRef.current) return
    gsap.fromTo(
      gridRef.current.querySelectorAll('.manga-card'),
      { opacity: 0, y: 14 },
      { opacity: 1, y: 0, duration: .38, stagger: .055, ease: 'power2.out', clearProps: 'all' }
    )
  }, [filtered.length, query])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
      <div className="spin" style={{ width: 28, height: 28 }} />
    </div>
  )

  if (!mangas.length) return (
    <div className="page">
      <div className="empty fade-up">
        <div className="icon">📭</div>
        <p>Bibliothèque vide.<br />
          <span style={{ color: 'var(--accent)' }}>+ Extraire</span> pour ajouter un manga.</p>
      </div>
    </div>
  )

  return (
    <div>
      {!query && <HeroCarousel mangas={mangas} />}

      {!query && continueItems.length > 0 && (
        <div className="continue-section">
          <div className="continue-title">Reprendre la lecture</div>
          <div className="continue-row">
            {continueItems.map((it) => (
              <div key={`${it.id}-${it.chapter_number}`} className="continue-card"
                onClick={() => navigate(`/manga/${it.id}/read/${it.chapter_number}?p=${it.page ?? 0}`)}>
                <div className="continue-thumb">
                  {it.cover_url
                    ? <img src={it.cover_url} alt={it.name} onError={(e) => { e.target.style.display = 'none' }} />
                    : <div className="continue-ph">📖</div>}
                  <div className="continue-play">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                  </div>
                  <div className="continue-bar"><div style={{ width: `${it.percent}%` }} /></div>
                </div>
                <div className="continue-name">{it.name}</div>
                <div className="continue-sub">Chap. {it.chapter_number} · {it.percent}%</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!query && favItems.length > 0 && (
        <div className="continue-section">
          <div className="continue-title">Mes favoris</div>
          <div className="continue-row">
            {favItems.map((it) => (
              <div key={it.id} className="continue-card" onClick={() => navigate(`/manga/${it.id}`)}>
                <div className="continue-thumb">
                  {it.cover_url
                    ? <img src={it.cover_url} alt={it.name} onError={(e) => { e.target.style.display = 'none' }} />
                    : <div className="continue-ph">📖</div>}
                  <div className="continue-fav-badge">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                  </div>
                  {it.percent > 0 && <div className="continue-bar"><div style={{ width: `${it.percent}%` }} /></div>}
                </div>
                <div className="continue-name">{it.name}</div>
                <div className="continue-sub">{it.category} · {it.percent}%</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!query && recentlyAdded.length > 0 && (
        <div className="continue-section">
          <div className="continue-title">Récemment ajoutés</div>
          <div className="continue-row">
            {recentlyAdded.map((m) => (
              <div key={m.id} className="continue-card" onClick={() => navigate(`/manga/${m.id}`)}>
                <div className="continue-thumb">
                  {m.cover_url
                    ? <img src={m.cover_url} alt={m.name} onError={(e) => { e.target.style.display = 'none' }} />
                    : <div className="continue-ph">📖</div>}
                </div>
                <div className="continue-name">{m.name}</div>
                <div className="continue-sub">{m.category} · {m.chapter_count} ch.</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={`home-content ${query ? 'searching' : ''}`}>
        <div className="section">
          <div className="section-head">
            <div className="section-title">
              {query ? `Résultats pour « ${query} »` : 'Ma bibliothèque'}
            </div>
            <div className="section-count">{filtered.length}{!query && ` / ${mangas.length}`}</div>
            {selectedGenres.size > 0 && (
              <button onClick={() => setSelectedGenres(new Set())} style={{
                background: 'none', border: 'none', color: 'var(--accent)',
                fontSize: '.75rem', cursor: 'pointer', padding: '0 .4rem',
              }}>✕ Réinitialiser</button>
            )}
            <button
              onClick={() => setFilterOpen((o) => !o)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '.3rem', color: filterOpen || selectedGenres.size > 0 ? 'var(--accent)' : 'rgba(255,255,255,.5)', display: 'flex', alignItems: 'center' }}
              title="Filtrer par genre"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
              </svg>
            </button>
          </div>

          {filterOpen && (
            <div ref={filterRef} className="filter-panel">
              {allGenres.length === 0 ? (
                <span style={{ color: 'rgba(255,255,255,.4)', fontSize: '.8rem' }}>Chargement des genres…</span>
              ) : allGenres.map((g) => (
                <button
                  key={g}
                  className={`filter-tag ${selectedGenres.has(g) ? 'active' : ''}`}
                  onClick={() => toggleGenre(g)}
                >{g}</button>
              ))}
            </div>
          )}
          {!filtered.length ? (
            <div className="empty" style={{ padding: '2rem 0' }}>
              <p>Aucun manga ne correspond à « {query} »</p>
            </div>
          ) : (
            <div className="manga-grid" ref={gridRef}>
              {filtered.map((m) => (
                <MangaCard
                  key={m.id}
                  manga={m}
                  isNew={newIds.has(m.id)}
                  isUpdating={hasActiveJobForManga(m)}
                  favorite={favSet.has(m.id)}
                  percent={progressMap[m.id] || 0}
                  onToggleFav={() => toggleFav(m.id)}
                  previewing={previewId === m.id}
                  onPreview={() => setPreviewId(m.id)}
                  onClick={() => navigate(`/manga/${m.id}`)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
