import React, { useState, useEffect, useRef, useCallback, useContext } from 'react'
import { useNavigate } from 'react-router-dom'
import { gsap } from 'gsap'
import { api } from '../api/client'
import { SearchCtx } from '../App'

// ── Manga Card ─────────────────────────────────────────────────────────────

const infoCache = {}

function MangaCard({ manga, onClick }) {
  const [imgOk, setImgOk] = useState(!!manga.cover_url)
  const [info, setInfo] = useState(infoCache[manga.id] || null)
  const infoLoadingRef = useRef(false)
  const timerRef = useRef()

  const onEnter = () => {
    // Lazy load info on hover (480ms delay)
    timerRef.current = setTimeout(() => {
      if (!info && !infoLoadingRef.current) {
        infoLoadingRef.current = true
        api.getMangaInfo(manga.id)
          .then((i) => {
            infoCache[manga.id] = i
            setInfo(i)
          })
          .catch(() => { })
      }
    }, 480)
  }

  const onLeave = () => {
    clearTimeout(timerRef.current)
  }

  useEffect(() => {
    return () => clearTimeout(timerRef.current)
  }, [])

  const genres = info?.genres?.slice(0, 3) || []
  const synopsis = info?.synopsis

  return (
    <div className="manga-card" onClick={onClick} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="manga-card-img">
        {imgOk
          ? <img src={manga.cover_url} alt={manga.name} onError={() => setImgOk(false)} />
          : <div className="manga-card-ph">📖</div>
        }
        {/* Overlay on hover with genres + synopsis */}
        <div className="manga-card-overlay-info">
          {genres.length > 0 && (
            <div className="card-genres">
              {genres.map((g) => <span key={g} className="card-genre">{g}</span>)}
            </div>
          )}
          {synopsis && <p className="card-synopsis">{synopsis}</p>}
        </div>
      </div>
      <div className="manga-card-info">
        <div className="manga-card-name">{manga.name}</div>
        <div className="manga-card-cat">{manga.chapter_count} chap. · {manga.category}</div>
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
        <div className="hero-sub">{m.category} · {m.chapter_count} chap.</div>

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
          <button className="btn btn-white" onClick={() => navigate(`/manga/${m.id}`)}>▶ Lire</button>
          <button className="btn btn-dark" onClick={() => navigate(`/manga/${m.id}`)}>ⓘ Détails</button>
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
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const gridRef = useRef()
  const { query } = useContext(SearchCtx)

  useEffect(() => {
    api.listMangas().then(setMangas).catch(console.error).finally(() => setLoading(false))
  }, [])

  const filtered = query
    ? mangas.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()))
    : mangas

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
      <div style={{ padding: query ? '88px 4% 5rem' : '0 4% 5rem' }}>
        <div className="section">
          <div className="section-head">
            <div className="section-title">
              {query ? `Résultats pour « ${query} »` : 'Ma bibliothèque'}
            </div>
            <div className="section-count">{filtered.length}{!query && ` / ${mangas.length}`}</div>
          </div>
          {!filtered.length ? (
            <div className="empty" style={{ padding: '2rem 0' }}>
              <p>Aucun manga ne correspond à « {query} »</p>
            </div>
          ) : (
            <div className="manga-grid" ref={gridRef}>
              {filtered.map((m) => (
                <MangaCard key={m.id} manga={m} onClick={() => navigate(`/manga/${m.id}`)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
