const BASE = '/api'

function getToken() {
  return localStorage.getItem('token')
}

async function req(path, options = {}) {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Erreur inconnue')
  }
  return res.json()
}

export const api = {
  // Auth
  login: (username, password) =>
    req('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  register: (username, password) =>
    req('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  me: () => req('/auth/me'),

  // Library
  listMangas: () => req('/mangas'),
  getManga: (id) => req(`/mangas/${id}`),
  epubUrl: (mangaId, chapterNum) => `${BASE}/mangas/${mangaId}/chapters/${chapterNum}/epub`,

  // Search
  search: (q) => req(`/search?q=${encodeURIComponent(q)}`),
  getCategories: (url) => req(`/search/categories?url=${encodeURIComponent(url)}`),
  getChapters: (url) => req(`/search/chapters?url=${encodeURIComponent(url)}`),

  // Manga info (scraped metadata)
  getMangaInfo: (id) => req(`/mangas/${id}/info`),
  refreshMangaInfo: (id) => req(`/mangas/${id}/info?force=true`),

  // Download chapters
  downloadChapters: async (mangaId, chapNums) => {
    const token = getToken()
    const res = await fetch(`${BASE}/mangas/${mangaId}/chapters/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ chapter_numbers: chapNums }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || 'Erreur inconnue')
    }
    const blob = await res.blob()
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `chapitres.zip`
    document.body.appendChild(a)
    a.click()
    window.URL.revokeObjectURL(url)
    document.body.removeChild(a)
  },

  // Extract
  extract: (body) =>
    req('/extract', { method: 'POST', body: JSON.stringify(body) }),

  // Jobs
  listJobs: () => req('/jobs'),
  getJob: (id) => req(`/jobs/${id}`),
  jobStreamUrl: (id) => `${BASE}/jobs/${id}/stream`,
}
