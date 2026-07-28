import React, { useState, useContext, useRef, useEffect } from 'react'
import { api } from '../api/client'
import { JobsCtx } from '../App'

const S = { SEARCH: 0, CAT: 1, CHAP: 2 }

export default function SearchModal({ onClose, prefillMangaName = '', prefillWorkUrl = '' }) {
  const { addJob, updateJob } = useContext(JobsCtx)

  const [step, setStep] = useState(prefillWorkUrl ? S.CAT : S.SEARCH)
  const [query, setQuery] = useState(prefillMangaName)
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [err, setErr] = useState('')

  const [selected, setSelected] = useState(
    prefillWorkUrl ? { title: prefillMangaName, work_url: prefillWorkUrl } : null
  )
  const [cats, setCats] = useState([])
  const [cat, setCat] = useState(null)
  const [chapInfo, setChapInfo] = useState(null)
  const [start, setStart] = useState(1)
  const [end, setEnd] = useState(1)
  const [extracting, setExtracting] = useState(false)
  const [loadingCats, setLoadingCats] = useState(false)

  const deb = useRef(null)

  // Auto-fetch categories when opened from manga detail (with timeout)
  useEffect(() => {
    if (!prefillWorkUrl) return
    setLoadingCats(true)
    const timeout = setTimeout(() => {
      setLoadingCats(false)
      setErr('Délai dépassé. Recherche manuellement ton manga ci-dessous.')
      setStep(S.SEARCH)
    }, 12000)

    api.getCategories(prefillWorkUrl)
      .then((data) => {
        clearTimeout(timeout)
        setCats(data)
      })
      .catch((e) => {
        clearTimeout(timeout)
        setErr(e.message)
        setStep(S.SEARCH)
      })
      .finally(() => {
        clearTimeout(timeout)
        setLoadingCats(false)
      })

    return () => clearTimeout(timeout)
  }, []) // eslint-disable-line

  const doSearch = async (q) => {
    if (!q.trim()) { setResults([]); return }
    setSearching(true); setErr('')
    try { setResults(await api.search(q)) }
    catch (e) { setErr(e.message) }
    finally { setSearching(false) }
  }

  const onQuery = (e) => {
    setQuery(e.target.value)
    clearTimeout(deb.current)
    deb.current = setTimeout(() => doSearch(e.target.value), 380)
  }

  const pickResult = async (r) => {
    setSelected(r); setErr(''); setCats([]); setStep(S.CAT); setLoadingCats(true)
    try { setCats(await api.getCategories(r.work_url)) }
    catch (e) { setErr(e.message) }
    finally { setLoadingCats(false) }
  }

  const pickCat = async (c) => {
    setCat(c); setErr(''); setStep(S.CHAP)
    try {
      const info = await api.getChapters(c.url)
      setChapInfo(info); setStart(info.first_chapter); setEnd(info.last_chapter)
    } catch (e) { setErr(e.message) }
  }

  const extract = async () => {
    setExtracting(true); setErr('')
    try {
      const job = await api.extract({
        work_url: selected.work_url,
        category_url: cat.url,
        manga_name: selected.title,
        category_label: cat.label,
        scan_title: chapInfo.scan_title,
        start_chapter: Number(start),
        end_chapter: Number(end),
      })
      addJob(job)
      const es = new EventSource(api.jobStreamUrl(job.id))
      es.onmessage = (e) => {
        const d = JSON.parse(e.data)
        updateJob(job.id, d)
        if (d.status === 'done' || d.status === 'error') es.close()
      }
      onClose()
    } catch (e) {
      setErr(e.message)
    } finally {
      setExtracting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>
            {step === S.SEARCH && 'Rechercher un manga'}
            {step === S.CAT && (selected?.title || 'Catégorie')}
            {step === S.CHAP && `${cat?.label} — Chapitres`}
          </h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        {err && <div className="err-msg">{err}</div>}

        {/* ── SEARCH STEP ── */}
        {step === S.SEARCH && (
          <>
            <div className="s-row">
              <input autoFocus placeholder="Titre du manga..." value={query} onChange={onQuery} />
              {searching && <div className="spin" style={{ alignSelf: 'center' }} />}
            </div>
            <div className="s-results">
              {results.map((r) => (
                <div key={r.work_url} className="s-item" onClick={() => pickResult(r)}>
                  {r.image_url
                    ? <img className="s-item-thumb" src={r.image_url} alt="" onError={(e) => e.target.style.display = 'none'} />
                    : <div className="s-item-thumb-ph">📖</div>
                  }
                  <div className="s-item-body">
                    <div className="s-item-title">{r.title}</div>
                    {r.subtitle && <div className="s-item-sub">{r.subtitle}</div>}
                  </div>
                </div>
              ))}
              {!results.length && query && !searching && (
                <div style={{ color: 'rgba(255,255,255,.3)', textAlign: 'center', padding: '1.5rem .5rem', fontSize: '.85rem' }}>
                  Aucun résultat pour « {query} »
                </div>
              )}
            </div>
          </>
        )}

        {/* ── CATEGORY STEP ── */}
        {step === S.CAT && (
          <>
            <div className="step-lbl">Sélectionne une catégorie</div>
            {loadingCats ? (
              <div className="modal-spinner-state">
                <div className="spin" />
                <span className="modal-timeout-hint">Connexion au site en cours…</span>
              </div>
            ) : (
              <div className="cats">
                {cats.map((c) => (
                  <button key={c.url} className={`cat-pill ${cat?.url === c.url ? 'on' : ''}`}
                    onClick={() => pickCat(c)}>
                    {c.label}
                  </button>
                ))}
                {!cats.length && !err && (
                  <span style={{ color: 'rgba(255,255,255,.35)', fontSize: '.83rem' }}>
                    Aucune catégorie trouvée
                  </span>
                )}
              </div>
            )}
            <div className="modal-acts" style={{ marginTop: '.5rem' }}>
              <button className="btn btn-dark btn-sm" onClick={() => { setStep(S.SEARCH); setErr('') }}>
                ← Rechercher
              </button>
            </div>
          </>
        )}

        {/* ── CHAPTERS STEP ── */}
        {step === S.CHAP && chapInfo && (
          <>
            <div className="step-lbl">
              Chapitres disponibles : {chapInfo.first_chapter} → {chapInfo.last_chapter}
            </div>
            <div className="range-row">
              <div className="range-f">
                <label>Début</label>
                <input type="number" value={start} min={chapInfo.first_chapter} max={chapInfo.last_chapter}
                  onChange={(e) => setStart(e.target.value)} />
              </div>
              <div className="range-f">
                <label>Fin</label>
                <input type="number" value={end} min={chapInfo.first_chapter} max={chapInfo.last_chapter}
                  onChange={(e) => setEnd(e.target.value)} />
              </div>
            </div>
            <div className="modal-acts">
              <button className="btn btn-dark btn-sm" onClick={() => setStep(S.CAT)}>← Retour</button>
              <button className="btn btn-primary" onClick={extract} disabled={extracting}
                style={{ flex: 1, justifyContent: 'center' }}>
                {extracting
                  ? <><div className="spin" style={{ width: 14, height: 14 }} /> Lancement…</>
                  : '⬇ Extraire'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
