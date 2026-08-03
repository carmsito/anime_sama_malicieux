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
