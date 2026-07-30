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

  // Users (admin)
  listUsers: () => req('/auth/users'),
  createUser: (username, password, role) =>
    req('/auth/users', { method: 'POST', body: JSON.stringify({ username, password, role }) }),
  setUserRole: (id, role) => req(`/auth/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),
  deleteUser: (id) => req(`/auth/users/${id}`, { method: 'DELETE' }),

  // Library
  listMangas: () => req('/mangas'),
  getManga: (id) => req(`/mangas/${id}`),
  getMangaVariants: (id) => req(`/mangas/${id}/variants`),
  epubUrl: (mangaId, chapterNum) => `${BASE}/mangas/${mangaId}/chapters/${chapterNum}/epub`,
  deleteChapter: (mangaId, chapterNum) =>
    req(`/mangas/${mangaId}/chapters/${chapterNum}`, { method: 'DELETE' }),

  // Reading progress
  getProgress: (mangaId) => req(`/mangas/${mangaId}/progress`),
  saveProgress: (mangaId, chapterNum, page, totalPages) =>
    req(`/mangas/${mangaId}/chapters/${chapterNum}/progress`,
        { method: 'PUT', body: JSON.stringify({ page, total_pages: totalPages }) }),

  // Search — Anime-Sama (backward compat)
  search: (q) => req(`/search?q=${encodeURIComponent(q)}`),
  getCategories: (url) => req(`/search/categories?url=${encodeURIComponent(url)}`),
  getChapters: (url) => req(`/search/chapters?url=${encodeURIComponent(url)}`),

  // Search — multi-source
  searchSource: (q, source) => req(`/search?q=${encodeURIComponent(q)}&source=${encodeURIComponent(source)}`),

  // MangaDex specific
  getMangaDexLanguages: (mangaId) => req(`/search/mangadex/languages?manga_id=${encodeURIComponent(mangaId)}`),
  getMangaDexChapters: (mangaId, lang) =>
    req(`/search/mangadex/chapters?manga_id=${encodeURIComponent(mangaId)}&lang=${encodeURIComponent(lang)}`),

  // Sushiscan specific
  getSushiscanChapters: (url) => req(`/search/sushiscan/chapters?url=${encodeURIComponent(url)}`),
  closeSushiscan: () => req('/search/sushiscan/close', { method: 'POST' }),

  // Manga info (scraped metadata)
  getMangaInfo: (id) => req(`/mangas/${id}/info`),
  refreshMangaInfo: (id) => req(`/mangas/${id}/info-refresh`, { method: 'POST' }),

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
