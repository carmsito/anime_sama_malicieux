import React, { useState, useContext, useRef, useEffect } from 'react'
import { api } from '../api/client'
import { JobsCtx } from '../contexts'

const S = { SEARCH: 0, CAT: 1, LANG: 1, CHAP: 2 }
const SOURCES = ['anime-sama', 'mangadex', 'sushiscan']
const SOURCE_LABELS = { 'anime-sama': 'Anime-Sama', 'mangadex': 'MangaDex', 'sushiscan': 'Sushiscan' }
const SEARCH_DEBOUNCE_MS = {
  'anime-sama': 380,
  mangadex: 380,
  sushiscan: 3000,
}

function SearchResultItem({ result, disabled, onPick }) {
  const [imgError, setImgError] = useState(false)

  return (
    <div className="s-item" onClick={() => !disabled && onPick(result)}>
      {result.image_url && !imgError
        ? <img className="s-item-thumb" src={result.image_url} alt="" onError={() => setImgError(true)} />
        : <div className="s-item-thumb-ph">&#128218;</div>}
      <div className="s-item-body">
        <div className="s-item-title">{result.title}</div>
        {result.subtitle && <div className="s-item-sub">{result.subtitle}</div>}
      </div>
    </div>
  )
}

export default function SearchModal({
  onClose,
  prefillMangaName = '',
  prefillWorkUrl = '',
  prefillSource = 'anime-sama',
}) {
  const { addJob, updateJob } = useContext(JobsCtx)

  const [source, setSource] = useState(prefillSource)
  const [step, setStep] = useState(
    prefillWorkUrl
      ? (prefillSource === 'anime-sama' ? S.CAT : prefillSource === 'mangadex' ? S.LANG : S.CHAP)
      : S.SEARCH
  )
  const [query, setQuery] = useState(prefillMangaName)
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [err, setErr] = useState('')
  const [selected, setSelected] = useState(
    prefillWorkUrl ? { title: prefillMangaName, work_url: prefillWorkUrl } : null
  )
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [extracting, setExtracting] = useState(false)

  const [cats, setCats] = useState([])
  const [cat, setCat] = useState(null)
  const [chapInfo, setChapInfo] = useState(null)
  const [loadingCats, setLoadingCats] = useState(false)

  const [langs, setLangs] = useState([])
  const [loadingLangs, setLoadingLangs] = useState(false)
  const [selectedLang, setSelectedLang] = useState(null)
  const [mdChapInfo, setMdChapInfo] = useState(null)

  const [sushiChapInfo, setSushiChapInfo] = useState(null)
  const [loadingSushi, setLoadingSushi] = useState(false)
  const [selectedKind, setSelectedKind] = useState(null)

  const deb = useRef(null)
  const mountedRef = useRef(true)
  const extractStartedRef = useRef(false)
  const sushiTouchedRef = useRef(prefillSource === 'sushiscan')
  const sourceRef = useRef(prefillSource)
  const queryRef = useRef(prefillMangaName)
  const searchReqRef = useRef(0)

  const invalidatePendingSearch = () => {
    clearTimeout(deb.current)
    searchReqRef.current += 1
  }

  const resetSourceState = (nextSource) => {
    sourceRef.current = nextSource
    setSource(nextSource)
    setStep(S.SEARCH)
    setResults([])
    setSelected(null)
    setErr('')
    setStart('')
    setEnd('')
    setCats([])
    setCat(null)
    setChapInfo(null)
    setLangs([])
    setSelectedLang(null)
    setMdChapInfo(null)
    setSushiChapInfo(null)
    setSelectedKind(null)
  }

  const closeSushiIfIdle = () => {
    if (!sushiTouchedRef.current || extractStartedRef.current) return
    api.closeSushiscan().catch(() => {})
  }

  const modalBusy = loadingCats || loadingLangs || loadingSushi || extracting

  const scheduleSearch = (value, searchSource = sourceRef.current, delay = SEARCH_DEBOUNCE_MS[searchSource] || 380) => {
    invalidatePendingSearch()
    if (!value.trim()) {
      setResults([])
      setSearching(false)
      return
    }
    if (searchSource === 'sushiscan') {
      sushiTouchedRef.current = true
    }
    deb.current = setTimeout(() => { doSearch(value, searchSource) }, delay)
  }

  const handleClose = () => {
    invalidatePendingSearch()
    onClose()
    closeSushiIfIdle()
  }

  const switchSource = (nextSource) => {
    if (nextSource === sourceRef.current) return
    invalidatePendingSearch()
    if (source === 'sushiscan' && nextSource !== 'sushiscan') {
      closeSushiIfIdle()
    }
    resetSourceState(nextSource)
    if (queryRef.current.trim() && nextSource !== 'sushiscan') {
      scheduleSearch(queryRef.current, nextSource, 120)
    }
  }

  useEffect(() => {
    return () => {
      mountedRef.current = false
      invalidatePendingSearch()
      if (sushiTouchedRef.current && !extractStartedRef.current) {
        api.closeSushiscan().catch(() => {})
      }
    }
  }, [])

  useEffect(() => {
    if (!prefillWorkUrl || source !== prefillSource) return
    let cancelled = false

    const run = async () => {
      const prefilled = { title: prefillMangaName, work_url: prefillWorkUrl }
      setSelected(prefilled)

      if (source === 'anime-sama') {
        setStep(S.CAT)
        setLoadingCats(true)
        try {
          const data = await api.getCategories(prefillWorkUrl)
          if (!cancelled && mountedRef.current) setCats(data)
        } catch (e) {
          if (!cancelled && mountedRef.current) {
            setErr(e.message)
            setStep(S.SEARCH)
          }
        } finally {
          if (!cancelled && mountedRef.current) setLoadingCats(false)
        }
        return
      }

      if (source === 'mangadex') {
        setStep(S.LANG)
        setLoadingLangs(true)
        try {
          const data = await api.getMangaDexLanguages(prefillWorkUrl)
          if (!cancelled && mountedRef.current) setLangs(data)
        } catch (e) {
          if (!cancelled && mountedRef.current) {
            setErr(e.message)
            setStep(S.SEARCH)
          }
        } finally {
          if (!cancelled && mountedRef.current) setLoadingLangs(false)
        }
        return
      }

      if (source === 'sushiscan') {
        sushiTouchedRef.current = true
        setStep(S.CHAP)
        setLoadingSushi(true)
        try {
          const info = await api.getSushiscanChapters(prefillWorkUrl)
          if (cancelled || !mountedRef.current) return
          setSushiChapInfo(info)
          const kinds = Object.keys(info.kinds || {})
          if (kinds.length === 1) {
            const k = kinds[0]
            setSelectedKind(k)
            setStart(String(info.kinds[k].first))
            setEnd(String(info.kinds[k].last))
          } else {
            setSelectedKind(null)
            setStart('')
            setEnd('')
          }
        } catch (e) {
          if (!cancelled && mountedRef.current) {
            setErr(e.message)
            setStep(S.SEARCH)
          }
        } finally {
          if (!cancelled && mountedRef.current) setLoadingSushi(false)
        }
      }
    }

    run()
    return () => { cancelled = true }
  }, [prefillMangaName, prefillSource, prefillWorkUrl, source])

  const doSearch = async (value, searchSource = sourceRef.current) => {
    if (!value.trim()) {
      if (mountedRef.current) setResults([])
      return
    }
    if (searchSource === 'sushiscan') {
      sushiTouchedRef.current = true
    }
    const reqId = ++searchReqRef.current
    setSearching(true)
    setErr('')
    try {
      const data = searchSource === 'anime-sama'
        ? await api.search(value)
        : await api.searchSource(value, searchSource)
      if (mountedRef.current && reqId === searchReqRef.current && searchSource === sourceRef.current) {
        if (searchSource === 'sushiscan') sushiTouchedRef.current = true
        setResults(data)
      }
    } catch (e) {
      if (mountedRef.current && reqId === searchReqRef.current && searchSource === sourceRef.current) {
        setErr(e.message)
      }
    } finally {
      if (mountedRef.current && reqId === searchReqRef.current && searchSource === sourceRef.current) {
        setSearching(false)
      }
    }
  }

  const onQuery = (e) => {
    const value = e.target.value
    setQuery(value)
    queryRef.current = value
    scheduleSearch(value)
  }

  const pickResult = async (r) => {
    setSelected(r)
    setErr('')

    if (source === 'anime-sama') {
      setCats([])
      setStep(S.CAT)
      setLoadingCats(true)
      try {
        const data = await api.getCategories(r.work_url)
        if (mountedRef.current) setCats(data)
      } catch (e) {
        if (mountedRef.current) setErr(e.message)
      } finally {
        if (mountedRef.current) setLoadingCats(false)
      }
      return
    }

    if (source === 'mangadex') {
      setLangs([])
      setStep(S.LANG)
      setLoadingLangs(true)
      try {
        const data = await api.getMangaDexLanguages(r.work_url)
        if (mountedRef.current) setLangs(data)
      } catch (e) {
        if (mountedRef.current) setErr(e.message)
      } finally {
        if (mountedRef.current) setLoadingLangs(false)
      }
      return
    }

    if (source === 'sushiscan') {
      sushiTouchedRef.current = true
      setLoadingSushi(true)
      try {
        const info = await api.getSushiscanChapters(r.work_url)
        if (!mountedRef.current) return
        setSushiChapInfo(info)
        const kinds = Object.keys(info.kinds || {})
        if (kinds.length === 1) {
          const k = kinds[0]
          setSelectedKind(k)
          setStart(String(info.kinds[k].first))
          setEnd(String(info.kinds[k].last))
        } else {
          setSelectedKind(null)
          setStart('')
          setEnd('')
        }
        setStep(S.CHAP)
      } catch (e) {
        if (mountedRef.current) setErr(e.message)
      } finally {
        if (mountedRef.current) setLoadingSushi(false)
      }
    }
  }

  const pickCat = async (c) => {
    setCat(c)
    setErr('')
    setStep(S.CHAP)
    try {
      const info = await api.getChapters(c.url)
      if (!mountedRef.current) return
      setChapInfo(info)
      setStart(String(info.first_chapter))
      setEnd(String(info.last_chapter))
    } catch (e) {
      if (mountedRef.current) setErr(e.message)
    }
  }

  const pickLang = async (l) => {
    setSelectedLang(l)
    setErr('')
    try {
      const info = await api.getMangaDexChapters(selected.work_url, l.lang)
      if (!mountedRef.current) return
      setMdChapInfo(info)
      setStart(info.first_chapter)
      setEnd(info.last_chapter)
      setStep(S.CHAP)
    } catch (e) {
      if (mountedRef.current) setErr(e.message)
    }
  }

  const buildExtractBody = () => {
    if (source === 'anime-sama') {
      return {
        source: 'anime-sama',
        work_url: selected.work_url,
        category_url: cat.url,
        manga_name: selected.title,
        category_label: cat.label,
        scan_title: chapInfo.scan_title,
        start_chapter: Number(start),
        end_chapter: Number(end),
      }
    }
    if (source === 'mangadex') {
      return {
        source: 'mangadex',
        manga_id: selected.work_url,
        manga_name: selected.title,
        lang: selectedLang.lang,
        start_chapter_str: String(start),
        end_chapter_str: String(end),
        start_chapter: 0,
        end_chapter: 0,
      }
    }
    return {
      source: 'sushiscan',
      manga_url: selected.work_url,
      manga_name: selected.title,
      kind: selectedKind,
      start_chapter: Number(start),
      end_chapter: Number(end),
    }
  }

  const canExtract = () => {
    if (extracting || !selected) return false
    if (source === 'anime-sama') return !!(cat && chapInfo && start !== '' && end !== '')
    if (source === 'mangadex') return !!(selectedLang && mdChapInfo && String(start).trim() && String(end).trim())
    if (source === 'sushiscan') return !!(sushiChapInfo && selectedKind && start !== '' && end !== '')
    return false
  }

  const goBack = () => {
    setErr('')
    if (step === S.CHAP) {
      if (source === 'anime-sama') setStep(S.CAT)
      else if (source === 'mangadex') setStep(S.LANG)
      else setStep(S.SEARCH)
    } else {
      setStep(S.SEARCH)
    }
  }

  const extract = async () => {
    setExtracting(true)
    setErr('')
    try {
      const job = await api.extract(buildExtractBody())
      addJob(job)
      extractStartedRef.current = true
      const es = new EventSource(api.jobStreamUrl(job.id))
      es.onmessage = (e) => {
        const d = JSON.parse(e.data)
        updateJob(job.id, d)
        if (d.status === 'done' || d.status === 'error') es.close()
      }
      onClose()
    } catch (e) {
      if (mountedRef.current) setErr(e.message)
    } finally {
      if (mountedRef.current) setExtracting(false)
    }
  }

  const modalTitle = () => {
    if (step === S.SEARCH) return 'Rechercher un manga'
    if (source === 'anime-sama') {
      if (step === S.CAT) return selected?.title || 'Catégorie'
      return `${cat?.label} — Chapitres`
    }
    if (source === 'mangadex') {
      if (step === S.LANG) return selected?.title || 'Langue'
      return `${selectedLang?.label} — Chapitres`
    }
    if (step === S.CHAP) return `${selected?.title || ''} — Chapitres`
    return selected?.title || 'Chapitres'
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && handleClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>{modalTitle()}</h2>
          <button className="modal-x" onClick={handleClose}>✕</button>
        </div>

        <div className="cats" style={{ marginBottom: '.75rem' }}>
          {SOURCES.map((s) => (
            <button
              key={s}
              className={`cat-pill ${source === s ? 'on' : ''}`}
              disabled={modalBusy}
              onClick={() => switchSource(s)}
            >
              {SOURCE_LABELS[s]}
            </button>
          ))}
        </div>

        {err && <div className="err-msg">{err}</div>}

        {step === S.SEARCH && (
          <>
            <div className="s-row">
              <input
                autoFocus
                placeholder={`Titre du manga (${SOURCE_LABELS[source]})...`}
                value={query}
                disabled={modalBusy}
                onChange={onQuery}
              />
              {(searching || loadingSushi) && <div className="spin" style={{ alignSelf: 'center' }} />}
            </div>
            {loadingSushi && (
              <div className="modal-spinner-state">
                <div className="spin" />
                <span className="modal-timeout-hint">Récupération des chapitres…</span>
              </div>
            )}
            <div className="s-results">
              {results.map((r) => (
                <SearchResultItem key={r.work_url} result={r} disabled={loadingSushi} onPick={pickResult} />
              ))}
              {!results.length && query && !searching && !loadingSushi && (
                <div style={{ color: 'rgba(255,255,255,.3)', textAlign: 'center', padding: '1.5rem .5rem', fontSize: '.85rem' }}>
                  Aucun résultat pour « {query} »
                </div>
              )}
            </div>
          </>
        )}

        {step === S.CAT && source === 'anime-sama' && (
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
                  <button key={c.url} className={`cat-pill ${cat?.url === c.url ? 'on' : ''}`} onClick={() => pickCat(c)}>
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
              <button className="btn btn-dark btn-sm" onClick={goBack}>&larr; Rechercher</button>
            </div>
          </>
        )}

        {step === S.LANG && source === 'mangadex' && (
          <>
            <div className="step-lbl">Sélectionne une langue</div>
            {loadingLangs ? (
              <div className="modal-spinner-state">
                <div className="spin" />
                <span className="modal-timeout-hint">Récupération des langues…</span>
              </div>
            ) : (
              <div className="cats">
                {langs.map((l) => (
                  <button key={l.lang} className={`cat-pill ${selectedLang?.lang === l.lang ? 'on' : ''}`} onClick={() => pickLang(l)}>
                    {l.label}
                    <span style={{ marginLeft: '.35rem', opacity: .6, fontSize: '.78em' }}>({l.count})</span>
                  </button>
                ))}
                {!langs.length && !err && (
                  <span style={{ color: 'rgba(255,255,255,.35)', fontSize: '.83rem' }}>
                    Aucune langue disponible
                  </span>
                )}
              </div>
            )}
            <div className="modal-acts" style={{ marginTop: '.5rem' }}>
              <button className="btn btn-dark btn-sm" onClick={goBack}>&larr; Rechercher</button>
            </div>
          </>
        )}

        {step === S.CHAP && source === 'anime-sama' && chapInfo && (
          <>
            <div className="step-lbl">Chapitres disponibles : {chapInfo.first_chapter} &rarr; {chapInfo.last_chapter}</div>
            <div className="range-row">
              <div className="range-f">
                <label>Début</label>
                <input type="number" value={start} min={chapInfo.first_chapter} max={chapInfo.last_chapter} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div className="range-f">
                <label>Fin</label>
                <input type="number" value={end} min={chapInfo.first_chapter} max={chapInfo.last_chapter} onChange={(e) => setEnd(e.target.value)} />
              </div>
            </div>
            <div className="modal-acts">
              <button className="btn btn-dark btn-sm" onClick={goBack}>&larr; Retour</button>
              <button className="btn btn-primary" onClick={extract} disabled={!canExtract()} style={{ flex: 1, justifyContent: 'center' }}>
                {extracting ? <><div className="spin" style={{ width: 14, height: 14 }} /> Lancement&hellip;</> : '⬇ Extraire'}
              </button>
            </div>
          </>
        )}

        {step === S.CHAP && source === 'mangadex' && mdChapInfo && (
          <>
            <div className="step-lbl">
              Chapitres disponibles : {mdChapInfo.first_chapter} &rarr; {mdChapInfo.last_chapter}
              <span style={{ marginLeft: '.5rem', opacity: .6, fontSize: '.85em' }}>({mdChapInfo.total} chapitres)</span>
            </div>
            <div className="range-row">
              <div className="range-f">
                <label>Début</label>
                <input type="text" value={start} placeholder={mdChapInfo.first_chapter} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div className="range-f">
                <label>Fin</label>
                <input type="text" value={end} placeholder={mdChapInfo.last_chapter} onChange={(e) => setEnd(e.target.value)} />
              </div>
            </div>
            <div className="modal-acts">
              <button className="btn btn-dark btn-sm" onClick={goBack}>&larr; Retour</button>
              <button className="btn btn-primary" onClick={extract} disabled={!canExtract()} style={{ flex: 1, justifyContent: 'center' }}>
                {extracting ? <><div className="spin" style={{ width: 14, height: 14 }} /> Lancement&hellip;</> : '⬇ Extraire'}
              </button>
            </div>
          </>
        )}

        {step === S.CHAP && source === 'sushiscan' && loadingSushi && (
          <>
            <div className="modal-spinner-state" style={{ flexDirection: 'row', alignItems: 'center' }}>
              <div className="spin" />
              <span className="modal-timeout-hint">Connexion à Sushiscan et récupération des chapitres…</span>
            </div>
          </>
        )}

        {step === S.CHAP && source === 'sushiscan' && !loadingSushi && sushiChapInfo && (
          <>
            {sushiChapInfo.kinds && Object.keys(sushiChapInfo.kinds).length > 1 && (
              <div style={{ display: 'flex', gap: '.5rem', marginBottom: '.8rem', flexWrap: 'wrap' }}>
                {Object.entries(sushiChapInfo.kinds).map(([k, info]) => (
                  <button
                    key={k}
                    onClick={() => {
                      setSelectedKind(k)
                      setStart(String(info.first))
                      setEnd(String(info.last))
                    }}
                    style={{
                      padding: '.35rem .75rem', borderRadius: '20px', border: 'none', cursor: 'pointer',
                      fontSize: '.8rem', fontWeight: 600, background: selectedKind === k ? '#e50914' : '#333', color: '#fff',
                    }}
                  >
                    {k}s ({info.total}) · {info.first}&rarr;{info.last}
                  </button>
                ))}
              </div>
            )}
            {selectedKind && (() => {
              const ki = sushiChapInfo.kinds?.[selectedKind] || { first: sushiChapInfo.first_chapter, last: sushiChapInfo.last_chapter }
              return (
                <div className="step-lbl">
                  {selectedKind}s disponibles : {ki.first} &rarr; {ki.last}
                  <span style={{ marginLeft: '.5rem', opacity: .6, fontSize: '.85em' }}>({ki.total})</span>
                </div>
              )
            })()}
            <div className="range-row">
              <div className="range-f">
                <label>Début</label>
                <input type="number" step="any" value={start} disabled={!selectedKind} min={sushiChapInfo.kinds?.[selectedKind]?.first || sushiChapInfo.first_chapter} max={sushiChapInfo.kinds?.[selectedKind]?.last || sushiChapInfo.last_chapter} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div className="range-f">
                <label>Fin</label>
                <input type="number" step="any" value={end} disabled={!selectedKind} min={sushiChapInfo.kinds?.[selectedKind]?.first || sushiChapInfo.first_chapter} max={sushiChapInfo.kinds?.[selectedKind]?.last || sushiChapInfo.last_chapter} onChange={(e) => setEnd(e.target.value)} />
              </div>
            </div>
            <div className="modal-acts">
              <button className="btn btn-dark btn-sm" onClick={goBack}>&larr; Rechercher</button>
              <button className="btn btn-primary" onClick={extract} disabled={!canExtract()} style={{ flex: 1, justifyContent: 'center' }}>
                {extracting ? <><div className="spin" style={{ width: 14, height: 14 }} /> Lancement&hellip;</> : '⬇ Extraire'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
