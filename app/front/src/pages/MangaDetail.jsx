import React, { useContext, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { gsap } from 'gsap'
import { api } from '../api/client'
import SearchModal from '../components/SearchModal'
import { JobsCtx } from '../contexts'

function ChapterCard({ manga, ch, onRead, isLoading, isSelected, onToggleSelect, selectionMode }) {
  const [ok, setOk] = useState(true)
  const label = ch.title || `Chapitre ${ch.number}`

  return (
    <div className="chapter-card" style={{ position: 'relative' }}>
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
          <img src={`/api/mangas/${manga.id}/chapters/${ch.number}/cover`} alt={label} onError={() => setOk(false)} />
        ) : (
          <div className="chapter-card-ph">📄</div>
        )}
        <div className="chapter-card-overlay" onClick={onRead}>
          <span style={{ fontSize: '1.8rem', fontWeight: 900, color: '#e50914', cursor: 'pointer' }}>Lire</span>
        </div>
        <a href={api.epubUrl(manga.id, ch.number)} download className="chapter-card-dl" onClick={(e) => e.stopPropagation()}>⬇</a>
      </div>
      <div className="chapter-card-foot">
        <div className="chapter-card-num">{label}</div>
      </div>
    </div>
  )
}

function PendingChapterCard({ label }) {
  return (
    <div className="chapter-card" style={{ position: 'relative' }}>
      <div className="chapter-card-img">
        <div style={{
          width: '100%', height: '100%',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: '.6rem',
          background: 'linear-gradient(145deg, #1a1a1a, #222)',
        }}>
          <div className="spin" style={{ width: 28, height: 28 }} />
          <div style={{ fontSize: '.74rem', color: 'rgba(255,255,255,.6)', fontWeight: 700 }}>
            Téléchargement…
          </div>
        </div>
      </div>
      <div className="chapter-card-foot">
        <div className="chapter-card-num">{label}</div>
      </div>
    </div>
  )
}

function formatPendingNumber(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '?'
  return Number.isInteger(value) ? `${value}.0` : String(value)
}

export default function MangaDetail() {
  const { mangaId } = useParams()
  const navigate = useNavigate()
  const { jobs } = useContext(JobsCtx)
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
  const mangaRef = useRef(null)
  const latestJobStateRef = useRef(null)

  const chapterKey = (ch) => `${ch.number}:${ch.title || ''}`
  const currentSource = manga?.source || 'anime-sama'
  const matchesCurrentMangaJob = (job) => (
    manga &&
    job.manga_name === manga.name &&
    job.source === currentSource &&
    (job.source !== 'anime-sama' || job.category === manga.category)
  )
  const latestRelevantJob = manga ? jobs.find(matchesCurrentMangaJob) : null
  const activeJob = latestRelevantJob && ['pending', 'running'].includes(latestRelevantJob.status)
    ? latestRelevantJob
    : null
  const itemLabel = manga?.kind || 'Chapitre'
  const itemLabelPlural = itemLabel === 'Chapitre' ? 'Chapitres' : `${itemLabel}s`

  useEffect(() => {
    mangaRef.current = manga
  }, [manga])

  useEffect(() => {
    Promise.all([
      api.getManga(mangaId),
      api.getMangaInfo(mangaId).catch(() => null),
    ]).then(([m, i]) => {
      mangaRef.current = m
      setManga(m)
      setInfo(i)
    }).finally(() => setLoading(false))
  }, [mangaId])

  useEffect(() => {
    if (!manga || !activeJob) return

    let cancelled = false
    const poll = async () => {
      try {
        const updated = await api.getManga(mangaId)
        if (cancelled || !updated || !updated.chapters) return

        const previous = mangaRef.current
        const previousKeys = new Set(previous?.chapters?.map(chapterKey) || [])
        const nextSignature = updated.chapters.map(chapterKey).join('|')
        const previousSignature = (previous?.chapters || []).map(chapterKey).join('|')

        if (nextSignature === previousSignature) return

        const added = updated.chapters.filter((ch) => !previousKeys.has(chapterKey(ch)))
        mangaRef.current = updated
        setManga(updated)

        added.forEach((ch) => {
          setLoadingChaps((prev) => new Set([...prev, ch.number]))
          setTimeout(() => {
            setLoadingChaps((prev) => {
              const next = new Set(prev)
              next.delete(ch.number)
              return next
            })
          }, 3000)
        })
      } catch (_) {
      }
    }

    poll()
    pollIntervalRef.current = setInterval(poll, 2000)
    return () => {
      cancelled = true
      clearInterval(pollIntervalRef.current)
    }
  }, [mangaId, activeJob?.id, activeJob?.status])

  useEffect(() => {
    const previous = latestJobStateRef.current
    const current = latestRelevantJob
      ? { id: latestRelevantJob.id, status: latestRelevantJob.status }
      : null
    latestJobStateRef.current = current

    if (!previous || !current) return
    if (previous.id !== current.id) return
    if (!['pending', 'running'].includes(previous.status)) return
    if (!['done', 'error'].includes(current.status)) return

    Promise.all([
      api.getManga(mangaId),
      api.getMangaInfo(mangaId).catch(() => info),
    ]).then(([refreshedManga, refreshedInfo]) => {
      mangaRef.current = refreshedManga
      setManga(refreshedManga)
      if (refreshedInfo) setInfo(refreshedInfo)
    }).catch(() => {})
  }, [info, latestRelevantJob, mangaId])

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
      const refreshedManga = await api.getManga(mangaId)
      setInfo(i)
      setManga(refreshedManga)
      mangaRef.current = refreshedManga
    } catch (err) {
      console.error('Erreur refresh:', err)
    } finally {
      setRefreshingInfo(false)
    }
  }

  const toggleChapSelect = (chapNum) => {
    setSelectedChaps(prev => {
      const next = new Set(prev)
      if (next.has(chapNum)) next.delete(chapNum)
      else next.add(chapNum)
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
      alert(`Erreur: ${err.message}`)
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

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
      <div className="spin" style={{ width: 28, height: 28 }} />
    </div>
  )
  if (!manga) return (
    <div className="page"><div className="empty"><div className="icon">❌</div><p>Introuvable</p></div></div>
  )

  const coverUrl = manga.cover_url || info?.cover_url
  const bgStyle = coverUrl ? { backgroundImage: `url(${coverUrl})` } : {}
  const first = manga.chapters?.[0]
  const sorted = (manga.chapters || [])
    .filter((ch) => !chapFilter || String(ch.number).includes(chapFilter))
    .sort((a, b) => sortAsc ? a.number - b.number : b.number - a.number)
  const pendingLabels = activeJob
    ? Array.from({ length: Math.max(0, (activeJob.total || 1) - activeJob.progress) }, (_, idx) => {
      const nextNumber = (activeJob.start_chapter || 0) + activeJob.progress + idx
      return `${itemLabel} ${formatPendingNumber(nextNumber)}`
    })
    : []

  const synopsis = info?.synopsis || ''
  const shortSyn = synopsis.length > 220 ? `${synopsis.slice(0, 220)}…` : synopsis
  const genres = info?.genres || []

  return (
    <div>
      <div className="detail-hero">
        <div className="detail-hero-bg" style={coverUrl ? bgStyle : { background: 'linear-gradient(135deg,#1a0812,#0a0a18)' }} />
        <div className="detail-hero-fade" />

        <button className="detail-back" onClick={() => navigate('/')}>←</button>

        <div className="detail-hero-body">
          <div className="detail-tag">{manga.category}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
            <div className="detail-title">{manga.name}</div>
            <button
              onClick={onRefreshInfo}
              disabled={refreshingInfo}
              className={`detail-refresh-btn ${(refreshingInfo || !!activeJob) ? 'spinning' : ''}`}
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
            <span>{manga.chapter_count} élément{manga.chapter_count !== 1 ? 's' : ''}</span>
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
                <button
                  onClick={() => setSynExpanded(!synExpanded)}
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.45)', cursor: 'pointer', fontSize: '.78rem', marginTop: '.25rem', fontFamily: 'inherit' }}
                >
                  {synExpanded ? 'Voir moins ↑' : 'Voir plus ↓'}
                </button>
              )}
            </div>
          )}

          <div className="detail-btns">
            {first && (
              <button className="btn btn-white" onClick={() => navigate(`/manga/${mangaId}/read/${first.number}`)}>
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
              title={selectionMode ? 'Désactiver la sélection' : 'Télécharger en masse'}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          </div>

          {activeJob && (
            <div style={{
              marginTop: '1rem',
              width: 'min(420px, 100%)',
              background: 'rgba(0,0,0,.32)',
              border: '1px solid rgba(255,255,255,.08)',
              borderRadius: 6,
              padding: '.8rem .9rem',
              backdropFilter: 'blur(6px)',
            }}>
              <div style={{ fontSize: '.8rem', color: 'rgba(255,255,255,.78)', marginBottom: '.45rem' }}>
                Extraction en cours: {activeJob.progress} / {activeJob.total || '?'} {itemLabelPlural.toLowerCase()}
              </div>
              <div style={{ height: 4, background: 'rgba(255,255,255,.08)', borderRadius: 999, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${activeJob.total > 0 ? Math.min(100, (activeJob.progress / activeJob.total) * 100) : 8}%`,
                    background: '#e50914',
                    transition: 'width .25s ease',
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: '0 4% 5rem' }}>
        <div className="section">
          <div className="section-head" style={{ flexWrap: 'wrap', gap: '1rem', alignItems: 'center' }}>
            <div className="section-title">{itemLabelPlural}</div>
            <div className="section-count">{sorted.length}{selectedChaps.size > 0 ? ` (${selectedChaps.size} sélectionné${selectedChaps.size > 1 ? 's' : ''})` : ''}</div>

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
                        for (let i = start; i <= end; i += 1) range.add(i)
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

                {selectedChaps.size > 0 && (
                  <button className="btn btn-primary btn-sm" onClick={onDownloadSelected} disabled={downloading}>
                    {downloading ? '⬇ Téléchargement...' : `⬇ Télécharger ${selectedChaps.size}`}
                  </button>
                )}
              </div>
            )}

            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ position: 'relative' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  style={{ position: 'absolute', left: '.65rem', top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,.35)', pointerEvents: 'none' }}>
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  placeholder={`N° de ${itemLabel.toLowerCase()}…`}
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
            pendingLabels.length > 0 ? (
              <div className="chapter-gallery" ref={galleryRef}>
                {pendingLabels.map((label, idx) => (
                  <PendingChapterCard key={`pending-${idx}`} label={label} />
                ))}
              </div>
            ) : (
              <div className="empty" style={{ padding: '2rem 0' }}>
                <p>{chapFilter ? `Aucun résultat pour « ${chapFilter} »` : `Aucun ${itemLabel.toLowerCase()} disponible`}</p>
              </div>
            )
          ) : (
            <div className="chapter-gallery" ref={galleryRef}>
              {sorted.map((ch) => (
                <ChapterCard
                  key={`${ch.title || 'chap'}-${ch.number}`}
                  manga={manga}
                  ch={ch}
                  onRead={() => navigate(`/manga/${mangaId}/read/${ch.number}`)}
                  isLoading={loadingChaps.has(ch.number)}
                  isSelected={selectedChaps.has(ch.number)}
                  onToggleSelect={() => toggleChapSelect(ch.number)}
                  selectionMode={selectionMode}
                />
              ))}
              {pendingLabels.map((label, idx) => (
                <PendingChapterCard key={`pending-${idx}`} label={label} />
              ))}
            </div>
          )}
        </div>
      </div>

      {showExtract && (
        <SearchModal
          onClose={() => setShowExtract(false)}
          prefillMangaName={manga.name}
          prefillWorkUrl={manga.work_url || ''}
          prefillSource={manga.source || 'anime-sama'}
        />
      )}
    </div>
  )
}
