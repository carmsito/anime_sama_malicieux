import React, { useState } from 'react'

// Modale de gestion de la playlist musique d'un manga. La lecture (audio) est pilotée
// par le parent (MangaDetail) via onPlay/curIdx, pour qu'elle SURVIVE à la fermeture.
export default function PlaylistModal({
  isAdmin, tracks, curIdx, adding, onAdd, onDelete, onPlay, onClose,
}) {
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (!url.trim()) return
    setErr('')
    try {
      await onAdd(url.trim())
      setUrl('')
    } catch (e2) {
      setErr(e2.message || 'Ajout impossible')
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-head">
          <h2>🎵 Playlist</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        {isAdmin && (
          <form onSubmit={submit} className="s-row" style={{ marginBottom: '.8rem' }}>
            <input
              placeholder="Colle un lien YouTube…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={adding}
            />
            <button className="btn btn-primary btn-sm" disabled={adding || !url.trim()} type="submit">
              {adding ? <span className="spin" style={{ width: 13, height: 13 }} /> : 'Ajouter'}
            </button>
          </form>
        )}
        {err && <div className="err-msg">{err}</div>}

        <div className="s-results" style={{ maxHeight: 340 }}>
          {tracks.map((t, i) => (
            <div key={t.id} className="s-item" style={{ cursor: 'pointer' }}>
              <div
                onClick={() => onPlay(i)}
                style={{
                  width: 30, height: 30, flexShrink: 0, borderRadius: '50%',
                  background: i === curIdx ? '#e50914' : 'rgba(255,255,255,.12)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                }}
                title="Lire"
              >
                {i === curIdx ? '♪' : '▶'}
              </div>
              <div className="s-item-body" onClick={() => onPlay(i)}>
                <div className="s-item-title" style={{ color: i === curIdx ? '#e50914' : undefined }}>
                  {t.title || t.url}
                </div>
              </div>
              {isAdmin && (
                <button
                  onClick={() => onDelete(t.id)}
                  title="Retirer"
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.4)', cursor: 'pointer', fontSize: '1.1rem', padding: '.2rem .4rem' }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {!tracks.length && (
            <div style={{ color: 'rgba(255,255,255,.35)', textAlign: 'center', padding: '1.5rem .5rem', fontSize: '.85rem' }}>
              {isAdmin ? 'Aucune piste — colle un lien YouTube ci-dessus.' : 'Aucune musique pour ce manga.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
