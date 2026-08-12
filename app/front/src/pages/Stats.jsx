import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { gsap } from 'gsap'
import { api } from '../api/client'

const SOURCE_LABELS = { 'anime-sama': 'Anime-Sama', mangadex: 'MangaDex', sushiscan: 'Sushiscan' }
const SOURCE_COLORS = { 'anime-sama': '#8b5cf6', mangadex: '#f59e0b', sushiscan: '#e50914' }

function StatCard({ value, label, accent }) {
  return (
    <div className="stat-card">
      <div className="stat-value" style={accent ? { color: '#e50914' } : undefined}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

function WorkRow({ w, onReset, onOpen }) {
  return (
    <div className="stat-work">
      <div className="stat-work-thumb" onClick={() => onOpen(w.id)}>
        {w.cover_url
          ? <img src={w.cover_url} alt="" onError={(e) => { e.target.style.display = 'none' }} />
          : <div className="stat-work-ph">📖</div>}
      </div>
      <div className="stat-work-main" onClick={() => onOpen(w.id)}>
        <div className="stat-work-name">{w.name}</div>
        <div className="stat-work-sub">
          {w.category} · {SOURCE_LABELS[w.source] || w.source} · {w.completed_chapters}/{w.chapter_count || '?'} lus
        </div>
        <div className="stat-work-bar"><div style={{ width: `${w.percent}%` }} /></div>
      </div>
      <div className="stat-work-pct">{w.percent}%</div>
      <button className="stat-work-reset" title="Réinitialiser (compter comme jamais lu)"
        onClick={() => onReset(w)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
      </button>
    </div>
  )
}

export default function Stats() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [heatMonths, setHeatMonths] = useState(1)   // fenêtre de la heatmap (mois)
  const [goal, setGoalState] = useState(() => Number(localStorage.getItem('reading_goal')) || 10)
  const setGoal = (g) => { const v = Math.max(1, Math.min(200, g || 1)); setGoalState(v); localStorage.setItem('reading_goal', String(v)) }
  const navigate = useNavigate()

  const load = () => api.getStats().then(setData).catch(() => {}).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!data) return
    gsap.fromTo('.stat-card', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: .4, stagger: .05, ease: 'power2.out' })
  }, [data])

  const onReset = async (w) => {
    if (!confirm(`Réinitialiser la progression de « ${w.name} » ?\nElle sera comptée comme jamais lue.`)) return
    try { await api.resetProgress(w.id); load() } catch (e) { alert(`Erreur: ${e.message}`) }
  }

  if (loading) return (
    <div className="page" style={{ display: 'flex', justifyContent: 'center', paddingTop: '20vh' }}>
      <div className="spin" style={{ width: 28, height: 28 }} />
    </div>
  )
  if (!data) return <div className="page"><div className="empty"><p>Statistiques indisponibles.</p></div></div>

  const t = data.totals
  const sources = Object.entries(data.by_source || {}).sort((a, b) => b[1] - a[1])
  const srcTotal = sources.reduce((s, [, n]) => s + n, 0) || 1
  const completionRate = t.works_started ? Math.round((t.works_completed / t.works_started) * 100) : 0

  // Heatmap d'activité : palette + alignement (lundi en haut)
  const act = data.activity || []
  const HEAT_DAYS = { 1: 31, 3: 92, 6: 183, 12: 371 }
  const heatAct = act.slice(-(HEAT_DAYS[heatMonths] || 31))
  const maxDay = heatAct.reduce((m, d) => Math.max(m, d.count), 0)
  const heat = (c) => {
    if (!c) return 'rgba(255,255,255,.06)'
    const r = c / (maxDay || 1)
    return r > 0.66 ? '#1f9d55' : r > 0.33 ? '#2ecc71' : 'rgba(46,204,113,.45)'
  }
  const firstRow = heatAct.length ? (new Date(heatAct[0].date + 'T00:00:00').getDay() + 6) % 7 : 0
  const wMax = Math.max(1, ...(data.by_weekday || [0]))
  const hMax = Math.max(1, ...(data.by_hour || [0]))

  // Objectif hebdo (7 derniers jours) + récap de l'année en cours
  const thisYear = String(new Date().getFullYear())
  const yearActs = act.filter((d) => d.date.startsWith(thisYear))
  const chaptersThisWeek = act.slice(-7).reduce((s, d) => s + d.count, 0)
  const chaptersThisYear = yearActs.reduce((s, d) => s + d.count, 0)
  const activeDaysYear = yearActs.filter((d) => d.count > 0).length
  const goalPct = Math.min(100, Math.round((chaptersThisWeek / goal) * 100))
  const topWork = (data.top || [])[0]

  return (
    <div className="page stats-page">
      <div className="stats-head">
        <h1>Mes statistiques</h1>
        <p>Ton activité de lecture en un coup d'œil.</p>
      </div>

      <div className="stats-grid">
        <StatCard value={t.works_started} label="Œuvres commencées" />
        <StatCard value={t.works_in_progress} label="En cours" accent />
        <StatCard value={t.works_completed} label="Terminées" />
        <StatCard value={t.chapters_read} label="Chapitres lus" />
        <StatCard value={t.pages_read.toLocaleString('fr-FR')} label="Planches lues" />
        <StatCard value={t.favorites} label="Favoris" />
        {data.streak && <StatCard value={`${data.streak.current} j`} label="Série en cours" accent />}
        {data.streak && <StatCard value={`${data.streak.best} j`} label="Record de série" />}
      </div>

      {/* Objectif hebdo + récap de l'année */}
      <div className="stats-two">
        <div className="stats-panel">
          <div className="stats-panel-title">Objectif de la semaine</div>
          <div className="stats-ring-wrap">
            <div className="stats-ring" style={{ background: `conic-gradient(#2ecc71 ${goalPct * 3.6}deg, rgba(255,255,255,.08) 0deg)` }}>
              <div className="stats-ring-hole">{chaptersThisWeek}/{goal}</div>
            </div>
            <div className="stats-ring-legend">
              <div>{chaptersThisWeek} chapitre{chaptersThisWeek > 1 ? 's' : ''} sur 7 jours</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem', marginTop: '.5rem' }}>
                <span style={{ color: 'var(--text2)', fontSize: '.8rem' }}>Objectif</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setGoal(goal - 1)}>−</button>
                <b>{goal}</b>
                <button className="btn btn-ghost btn-sm" onClick={() => setGoal(goal + 1)}>+</button>
                <span style={{ color: 'var(--text2)', fontSize: '.8rem' }}>/sem.</span>
              </div>
            </div>
          </div>
        </div>

        <div className="stats-panel">
          <div className="stats-panel-title">Cette année {thisYear}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.7rem', marginTop: '.3rem' }}>
            <div><div className="stat-value" style={{ fontSize: '1.5rem' }}>{chaptersThisYear}</div><div className="stat-label">chapitres lus</div></div>
            <div><div className="stat-value" style={{ fontSize: '1.5rem' }}>{activeDaysYear}</div><div className="stat-label">jours de lecture</div></div>
            <div><div className="stat-value" style={{ fontSize: '1.5rem' }}>{data.streak?.best || 0} j</div><div className="stat-label">plus longue série</div></div>
            <div><div className="stat-value" style={{ fontSize: '1.5rem' }}>{data.totals.works_completed}</div><div className="stat-label">œuvres terminées</div></div>
          </div>
          {topWork && (
            <div style={{ marginTop: '.8rem', fontSize: '.82rem', color: 'var(--text2)' }}>
              Œuvre phare : <b style={{ color: 'var(--text)' }}>{topWork.name}</b>
            </div>
          )}
        </div>
      </div>

      <div className="stats-two">
        {/* Taux de complétion */}
        <div className="stats-panel">
          <div className="stats-panel-title">Taux de complétion</div>
          <div className="stats-ring-wrap">
            <div className="stats-ring" style={{ background: `conic-gradient(#e50914 ${completionRate * 3.6}deg, rgba(255,255,255,.08) 0deg)` }}>
              <div className="stats-ring-hole">{completionRate}%</div>
            </div>
            <div className="stats-ring-legend">
              {t.works_completed} terminée{t.works_completed > 1 ? 's' : ''} sur {t.works_started} commencée{t.works_started > 1 ? 's' : ''}
            </div>
          </div>
        </div>

        {/* Répartition par source */}
        <div className="stats-panel">
          <div className="stats-panel-title">Par source</div>
          {sources.length === 0 && <div className="stats-empty">Aucune donnée</div>}
          {sources.map(([src, n]) => (
            <div key={src} className="stats-src-row">
              <span className="stats-src-name">{SOURCE_LABELS[src] || src}</span>
              <div className="stats-src-bar">
                <div style={{ width: `${(n / srcTotal) * 100}%`, background: SOURCE_COLORS[src] || '#888' }} />
              </div>
              <span className="stats-src-n">{n}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Activité — heatmap avec fenêtre 1/3/6/12 mois */}
      {heatAct.length > 0 && (
        <div className="stats-section">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '.5rem' }}>
            <div className="stats-panel-title" style={{ margin: 0 }}>Activité de lecture</div>
            <div style={{ display: 'flex', gap: '.35rem' }}>
              {[[1, '1 mois'], [3, '3 mois'], [6, '6 mois'], [12, '1 an']].map(([m, lbl]) => (
                <button key={m} onClick={() => setHeatMonths(m)}
                  style={{ padding: '.28rem .6rem', borderRadius: 13, border: 'none', cursor: 'pointer',
                    fontSize: '.76rem', fontWeight: 700,
                    background: heatMonths === m ? '#2ecc71' : 'rgba(255,255,255,.1)', color: '#fff' }}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>
          <div style={{ overflowX: 'auto', paddingBottom: 6, marginTop: '.6rem' }}>
            <div style={{ display: 'grid', gridTemplateRows: 'repeat(7, 11px)', gridAutoFlow: 'column', gap: 3, width: 'max-content' }}>
              {Array.from({ length: firstRow }).map((_, i) => <div key={`pad${i}`} />)}
              {heatAct.map((d) => (
                <div key={d.date} title={`${d.date} — ${d.count} chapitre(s)`}
                  style={{ width: 11, height: 11, borderRadius: 2, background: heat(d.count) }} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Quand tu lis : jour de semaine + heure */}
      {(data.by_weekday || data.by_hour) && (
        <div className="stats-two">
          <div className="stats-panel">
            <div className="stats-panel-title">Par jour de la semaine</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 92, marginTop: 10 }}>
              {(data.by_weekday || []).map((n, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
                  <div title={`${n} chapitre(s)`} style={{ width: '100%', maxWidth: 26, height: `${(n / wMax) * 66}px`, minHeight: n ? 4 : 0, background: '#e50914', borderRadius: 3, transition: 'height .3s' }} />
                  <span style={{ fontSize: '.68rem', color: 'var(--text2)' }}>{['L', 'M', 'M', 'J', 'V', 'S', 'D'][i]}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="stats-panel">
            <div className="stats-panel-title">Par heure</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 92, marginTop: 10 }}>
              {(data.by_hour || []).map((n, i) => (
                <div key={i} title={`${i}h — ${n} chapitre(s)`} style={{ flex: 1, height: `${(n / hMax) * 66}px`, minHeight: n ? 3 : 0, background: '#8b5cf6', borderRadius: 2, transition: 'height .3s' }} />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.66rem', color: 'var(--text3)', marginTop: 5 }}>
              <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span>
            </div>
          </div>
        </div>
      )}

      {/* Top œuvres */}
      {data.top?.length > 0 && (
        <div className="stats-section">
          <div className="stats-panel-title">Top œuvres lues</div>
          <div className="stats-top-row">
            {data.top.map((w) => (
              <div key={w.id} className="stats-top-card" onClick={() => navigate(`/manga/${w.id}`)}>
                <div className="stats-top-thumb">
                  {w.cover_url ? <img src={w.cover_url} alt="" onError={(e) => { e.target.style.display = 'none' }} /> : <div className="stat-work-ph">📖</div>}
                  <div className="stats-top-pct">{w.percent}%</div>
                </div>
                <div className="stats-top-name">{w.name}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Toutes les œuvres + reset */}
      <div className="stats-section">
        <div className="stats-panel-title">Progression par œuvre <span style={{ color: 'var(--text3)', fontWeight: 400 }}>· réinitialisable</span></div>
        {(!data.works || data.works.length === 0) && <div className="stats-empty">Tu n'as encore rien lu.</div>}
        <div className="stats-works">
          {data.works?.map((w) => (
            <WorkRow key={w.id} w={w} onReset={onReset} onOpen={(id) => navigate(`/manga/${id}`)} />
          ))}
        </div>
      </div>
    </div>
  )
}
