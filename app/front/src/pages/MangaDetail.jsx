import React, { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { gsap } from 'gsap'
import { api } from '../api/client'
import SearchModal from '../components/SearchModal'

function ChapterCard({ manga, ch, onRead, isLoading, isSelected, onToggleSelect, selectionMode }) {
  const [ok, setOk] = useState(true)
  return (
    <div className="chapter-card" style={{ position: 'relative' }}>
      {/* Selection circle radio button */}
      {selectionMode && (
        <button
          onClick={onToggleSelect}
          className={`chapter-card-select ${isSelected ? 'selected' : ''}`}
          title={isSelected ? 'Désélectionner' : 'Sélectionner'}
        />
      )}
      <div className="chapter-card-img">
        {isLoading ? (
          <div style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'linear-gradient(145deg, #1a1a1a, #222)',
          }}>
            <div className="spin" style={{ width: 28, height: 28 }} />
          </div>
        ) : ok ? (
          <img src={`/api/mangas/${manga.id}/chapters/${ch.number}/cover`}
            alt={`Chap. ${ch.number}`} onError={() => setOk(false)} />
        ) : (
          <div className="chapter-card-ph">📄</div>
        )}
        <div className="chapter-card-overlay" onClick={onRead}>
          <span style={{ fontSize: '1.8rem', fontWeight: 900, color: '#e50914', cursor: 'pointer' }}>Lire</span>
        </div>
        <a href={api.epubUrl(manga.id, ch.number)} download
          className="chapter-card-dl" onClick={(e) => e.stopPropagation()}>⬇</a>
      </div>
      <div className="chapter-card-foot">
        <div className="chapter-card-num">Chapitre {ch.number}</div>
      </div>
    </div>
  )
}

export default function MangaDetail() {
  const { mangaId } = useParams()
  const navigate = useNavigate()
  const [manga, setManga] = useState(null)
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showExtract, setShowExtract] = useState(false)
  const [sortAsc, setSortAsc] = useState(true)
  const [chapFilter, setChapFilter] = useState('')
  const [synExpanded, setSynExpanded] = useState(false)
  const [loadingChaps, setLoadingChaps] = useState(new Set())
  const [refreshingInfo, setRefreshingInfo] = useState(false)
  const [selectedChaps, setSelectedChaps] = useState(new Set())
  const [downloading, setDownloading] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [rangeInput, setRangeInput] = useState('')
  const galleryRef = useRef()
  const pollIntervalRef = useRef(null)

  // Initial load
  useEffect(() => {
    Promise.all([
      api.getManga(mangaId),
      api.getMangaInfo(mangaId).catch(() => null),
    ]).then(([m, i]) => {
      setManga(m)
      setInfo(i)
    }).finally(() => setLoading(false))
  }, [mangaId])

  // Poll for new chapters during extraction
  useEffect(() => {
    if (!manga) return

    const poll = async () => {
      try {
        const updated = await api.getManga(mangaId)
        if (updated && updated.chapters) {
          const oldChapNums = new Set(manga.chapters?.map(c => c.number) || [])
          const newChapNums = new Set(updated.chapters.map(c => c.number))
          const added = [...newChapNums].filter(n => !oldChapNums.has(n))

          if (added.length > 0) {
            setManga(updated)
            // Mark newly added chapters with loader
            added.forEach(num => {
              setLoadingChaps(prev => new Set([...prev, num]))
              // Auto-remove loader after 3s (cover should be ready by then)
              setTimeout(() => {
                setLoadingChaps(prev => {
                  const next = new Set(prev)
                  next.delete(num)
                  return next
                })
              }, 3000)
            })
          }
        }
      } catch (err) {
        // Silently ignore errors
      }
    }

    pollIntervalRef.current = setInterval(poll, 2000)
    return () => clearInterval(pollIntervalRef.current)
  }, [manga, mangaId])

  useEffect(() => {
    if (!manga || !galleryRef.current) return
    const cards = galleryRef.current.querySelectorAll('.chapter-card')
    gsap.fromTo(cards,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: .3, stagger: .03, ease: 'power2.out', clearProps: 'all' }
    )
  }, [manga, sortAsc, chapFilter])

  const onRefreshInfo = async () => {
    setRefreshingInfo(true)
    try {
      const i = await api.refreshMangaInfo(mangaId)
      setInfo(i)
    } catch (err) {
      console.error('Erreur refresh:', err)
    } finally {
      setRefreshingInfo(false)
    }
  }

  const toggleChapSelect = (chapNum) => {
    setSelectedChaps(prev => {
      const next = new Set(prev)
      if (next.has(chapNum)) {
        next.delete(chapNum)
      } else {
        next.add(chapNum)
      }
      return next
    })
  }

  const onDownloadSelected = async () => {
    if (selectedChaps.size === 0) return
    setDownloading(true)
    try {
      await api.downloadChapters(mangaId, Array.from(selectedChaps))
      setSelectedChaps(new Set())
      setSelectionMode(false)
    } catch (err) {
      console.error('Erreur download:', err)
      alert('Erreur: ' + err.message)
    } finally {
      setDownloading(false)
    }
  }

  const selectAll = () => {
    setSelectedChaps(new Set(manga.chapters?.map(c => c.number) || []))
  }

  const deselectAll = () => {
    setSelectedChaps(new Set())
  }

  const selectRange = () => {
    if (!rangeInput.trim()) return
    const parts = rangeInput.split('-').map(p => Number(p.trim())).filter(n => !isNaN(n))
    if (parts.length === 1) {
      setSelectedChaps(new Set([parts[0]]))
    } else if (parts.length === 2) {
      const [start, end] = [Math.min(...parts), Math.max(...parts)]
      const range = new Set()
      for (let i = start; i <= end; i++) range.add(i)
      setSelectedChaps(range)
    }
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
      <div className="spin" style={{ width: 28, height: 28 }} />
    </div>
  )
  if (!manga) return (
    <div className="page"><div className="empty"><div className="icon">❌</div><p>Introuvable</p></div></div>
  )

  const coverUrl = info?.cover_url || manga.cover_url
  const bgStyle = coverUrl ? { backgroundImage: `url(${coverUrl})` } : {}
  const first = manga.chapters?.[0]
  const sorted = (manga.chapters || [])
    .filter((ch) => !chapFilter || String(ch.number).includes(chapFilter))
    .sort((a, b) => sortAsc ? a.number - b.number : b.number - a.number)

  const synopsis = info?.synopsis || ''
  const shortSyn = synopsis.length > 220 ? synopsis.slice(0, 220) + '…' : synopsis
  const genres = info?.genres || []

  return (
    <div>
      {/* ── Hero ── */}
      <div className="detail-hero">
        <div className="detail-hero-bg"
          style={coverUrl ? bgStyle : { background: 'linear-gradient(135deg,#1a0812,#0a0a18)' }} />
        <div className="detail-hero-fade" />

        {/* ← back */}
        <button className="detail-back" onClick={() => navigate('/')}>←</button>

        {/* Info bottom-left */}
        <div className="detail-hero-body">
          <div className="detail-tag">{manga.category}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
            <div className="detail-title">{manga.name}</div>
            <button
              onClick={onRefreshInfo}
              disabled={refreshingInfo}
              style={{
                background: 'none', border: 'none', color: '#fff', cursor: 'pointer',
                padding: '.4rem', display: 'flex', alignItems: 'center', fontSize: '1.2rem',
                opacity: refreshingInfo ? 0.5 : 1, transition: 'opacity .2s',
              }}
              title="Rafraîchir les infos"
            >
              {refreshingInfo ? '↻' : '⟳'}
            </button>
          </div>

          <div className="detail-meta-line">
            <span>{manga.chapter_count} chapitre{manga.chapter_count !== 1 ? 's' : ''}</span>
            {info?.year && <><span className="detail-meta-dot">·</span><span>{info.year}</span></>}
            {info?.status && <><span className="detail-meta-dot">·</span><span>{info.status}</span></>}
            {info?.creator && <><span className="detail-meta-dot">·</span><span style={{ color: 'rgba(255,255,255,.5)' }}>{info.creator}</span></>}
          </div>

          {genres.length > 0 && (
            <div style={{ display: 'flex', gap: '.35rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
              {genres.map((g) => (
                <span key={g} style={{
                  padding: '.18rem .55rem', borderRadius: 3,
                  background: 'rgba(255,255,255,.12)', color: 'rgba(255,255,255,.75)',
                  fontSize: '.72rem', fontWeight: 600,
                }}>
                  {g}
                </span>
              ))}
            </div>
          )}

          {synopsis && (
            <div style={{ maxWidth: 560, marginBottom: '1.1rem' }}>
              <p style={{ fontSize: '.88rem', color: 'rgba(255,255,255,.7)', lineHeight: 1.65 }}>
                {synExpanded ? synopsis : shortSyn}
              </p>
              {synopsis.length > 220 && (
                <button onClick={() => setSynExpanded(!synExpanded)}
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.45)',
                    cursor: 'pointer', fontSize: '.78rem', marginTop: '.25rem', fontFamily: 'inherit' }}>
                  {synExpanded ? 'Voir moins ↑' : 'Voir plus ↓'}
                </button>
              )}
            </div>
          )}

          <div className="detail-btns">
            {first && (
              <button className="btn btn-white"
                onClick={() => navigate(`/manga/${mangaId}/read/${first.number}`)}>
                ▶ Lire depuis le début
              </button>
            )}
            <button className="btn btn-dark" onClick={() => setShowExtract(true)}>+ Extraire</button>
            <button
              onClick={() => { setSelectionMode(!selectionMode); if (!selectionMode) deselectAll() }}
              style={{
                background: 'none', border: 'none', color: '#fff', cursor: 'pointer',
                padding: '.4rem', display: 'flex', alignItems: 'center',
                opacity: selectionMode ? 1 : 0.6, transition: 'opacity .2s',
              }}
              title={selectionMode ? 'Désactiver la sélection' : 'Télécharger en masse'}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── Chapter section ── */}
      <div style={{ padding: '0 4% 5rem' }}>
        <div className="section">
          {/* Section header with inline filter */}
          <div className="section-head" style={{ flexWrap: 'wrap', gap: '1rem', alignItems: 'center' }}>
            <div className="section-title">Chapitres</div>
            <div className="section-count">{sorted.length}{selectedChaps.size > 0 ? ` (${selectedChaps.size} sélectionné${selectedChaps.size > 1 ? 's' : ''})` : ''}</div>

            {/* Selection controls */}
            {selectionMode && (
              <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn-sm btn-ghost" onClick={selectAll}>Tous</button>
                <button className="btn btn-sm btn-ghost" onClick={deselectAll}>Aucun</button>
                <input
                  placeholder="1-5"
                  value={rangeInput}
                  onChange={(e) => {
                    setRangeInput(e.target.value)
                    if (e.target.value.trim()) {
                      const parts = e.target.value.split('-').map(p => Number(p.trim())).filter(n => !isNaN(n))
                      if (parts.length === 1) {
                        setSelectedChaps(new Set([parts[0]]))
                      } else if (parts.length === 2) {
                        const [start, end] = [Math.min(...parts), Math.max(...parts)]
                        const range = new Set()
                        for (let i = start; i <= end; i++) range.add(i)
                        setSelectedChaps(range)
                      }
                    }
                  }}
                  style={{
                    width: 70, padding: '.35rem .6rem', fontSize: '.8rem',
                    background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.2)',
                    borderRadius: 3, color: '#fff', fontFamily: 'inherit', outline: 'none',
                  }}
                />

                {/* Download button */}
                {selectedChaps.size > 0 && (
                  <button className="btn btn-primary btn-sm" onClick={onDownloadSelected} disabled={downloading}>
                    {downloading ? '⬇ Téléchargement...' : `⬇ Télécharger ${selectedChaps.size}`}
                  </button>
                )}
              </div>
            )}

            {/* Chapter filter bar — clean inline design */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ position: 'relative' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  style={{ position: 'absolute', left: '.65rem', top: '50%', transform: 'translateY(-50%)',
                    color: 'rgba(255,255,255,.35)', pointerEvents: 'none' }}>
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input
                  placeholder="N° de chapitre…"
                  value={chapFilter}
                  onChange={(e) => setChapFilter(e.target.value)}
                  style={{
                    paddingLeft: '2rem', paddingRight: '.75rem', paddingTop: '.35rem', paddingBottom: '.35rem',
                    background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.12)',
                    borderRadius: 4, color: '#fff', fontSize: '.8rem', width: 150, outline: 'none',
                    fontFamily: 'inherit',
                  }}
                />
              </div>
              <button className={`sort-btn ${sortAsc ? 'active' : ''}`} onClick={() => setSortAsc(true)}>↑</button>
              <button className={`sort-btn ${!sortAsc ? 'active' : ''}`} onClick={() => setSortAsc(false)}>↓</button>
            </div>
          </div>

          {!sorted.length ? (
            <div className="empty" style={{ padding: '2rem 0' }}>
              <p>{chapFilter ? `Aucun résultat pour « ${chapFilter} »` : 'Aucun chapitre disponible'}</p>
            </div>
          ) : (
            <div className="chapter-gallery" ref={galleryRef}>
              {sorted.map((ch) => (
                <ChapterCard key={ch.number} manga={manga} ch={ch}
                  onRead={() => navigate(`/manga/${mangaId}/read/${ch.number}`)}
                  isLoading={loadingChaps.has(ch.number)}
                  isSelected={selectedChaps.has(ch.number)}
                  onToggleSelect={() => toggleChapSelect(ch.number)}
                  selectionMode={selectionMode} />
              ))}
            </div>
          )}
        </div>
      </div>

      {showExtract && (
        <SearchModal onClose={() => setShowExtract(false)}
          prefillMangaName={manga.name} prefillWorkUrl={manga.work_url || ''} />
      )}
    </div>
  )
}
