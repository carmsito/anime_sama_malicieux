// Détection des cases (panels) de MANGA, ordre de lecture droite→gauche puis haut→bas.
// Analyse canvas (images même origine → pas de taint), SANS ML, SANS son.
//
// HYBRIDE (deux méthodes complémentaires) :
//  • SEGMENTATION (flood-fill façon Kumiko) : robuste pour les mises en page complexes à MARGE
//    blanche (cases en L, chevauchements, gouttières diagonales). Dilatation d'encre pour ne pas
//    absorber les cases à fond clair/texturé.
//  • X-Y CUT (projection) EN REPLI : quand la segmentation ne trouve rien (planche à FOND PERDU,
//    l'art touche les bords → pas de fond au bord pour amorcer le flood) — ces pages sont des
//    grilles à gouttières droites que la projection découpe bien.
// Repli ultime : planche entière (1 case).

// ── Ordonnancement en sens manga : rangées (chevauchement vertical) haut→bas, droite→gauche ──
function orderManga(rects, w, h) {
  const rows = []
  for (const p of [...rects].sort((a, b) => a.y - b.y)) {
    const pb = p.y + p.h
    let row = null
    for (const r of rows) {
      const ov = Math.min(pb, r.y1) - Math.max(p.y, r.y0)
      if (ov > 0.5 * Math.min(p.h, r.y1 - r.y0)) { row = r; break }
    }
    if (row) { row.items.push(p); row.y0 = Math.min(row.y0, p.y); row.y1 = Math.max(row.y1, pb) }
    else rows.push({ y0: p.y, y1: pb, items: [p] })
  }
  rows.sort((a, b) => a.y0 - b.y0)
  const out = []
  for (const r of rows) { r.items.sort((a, b) => (b.x + b.w) - (a.x + a.w)); out.push(...r.items) }
  return out.map((p) => ({ x: p.x / w, y: p.y / h, w: p.w / w, h: p.h / h }))
}

// ── X-Y cut sur le masque d'encre `raw` (1 = encre). Table cumulée → somme rectangle O(1). ──
function xyCut(raw, w, h) {
  const sw = w + 1
  const sat = new Int32Array(sw * (h + 1))
  for (let y = 0; y < h; y++) {
    let rs = 0
    for (let x = 0; x < w; x++) { rs += raw[y * w + x]; sat[(y + 1) * sw + (x + 1)] = sat[y * sw + (x + 1)] + rs }
  }
  const S = (x0, y0, x1, y1) => sat[y1 * sw + x1] - sat[y0 * sw + x1] - sat[y1 * sw + x0] + sat[y0 * sw + x0]
  const minSide = Math.min(w, h) * 0.08
  const minGut = Math.max(4, Math.round(Math.min(w, h) * 0.014))
  const gapFrac = 0.012
  const gap = (lo, hi, empty) => {
    let best = null, i = lo
    while (i < hi) {
      if (!empty(i)) { i++; continue }
      let j = i; while (j < hi && empty(j)) j++
      const border = (i === lo) || (j === hi), sz = j - i
      if (!border && sz >= minGut && (!best || sz > best.size)) best = { start: i, end: j, size: sz }
      i = j
    }
    return best
  }
  const out = []
  const stack = [{ x0: 0, y0: 0, x1: w, y1: h, d: 0 }]
  while (stack.length) {
    const r = stack.pop(), bw = r.x1 - r.x0, bh = r.y1 - r.y0
    if (bw < minSide || bh < minSide || r.d > 9) { out.push(r); continue }
    const rt = bw * gapFrac, ct = bh * gapFrac
    const hG = gap(r.y0, r.y1, (y) => S(r.x0, y, r.x1, y + 1) <= rt)
    const vG = gap(r.x0, r.x1, (x) => S(x, r.y0, x + 1, r.y1) <= ct)
    if (hG && (!vG || hG.size >= vG.size)) {
      stack.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: hG.start, d: r.d + 1 })
      stack.push({ x0: r.x0, y0: hG.end, x1: r.x1, y1: r.y1, d: r.d + 1 })
    } else if (vG) {
      stack.push({ x0: r.x0, y0: r.y0, x1: vG.start, y1: r.y1, d: r.d + 1 })
      stack.push({ x0: vG.end, y0: r.y0, x1: r.x1, y1: r.y1, d: r.d + 1 })
    } else out.push(r)
  }
  const trim = (r) => {
    let x0 = r.x0, x1 = r.x1, y0 = r.y0, y1 = r.y1
    while (x0 < x1 && S(x0, r.y0, x0 + 1, r.y1) === 0) x0++
    while (x1 > x0 && S(x1 - 1, r.y0, x1, r.y1) === 0) x1--
    while (y0 < y1 && S(r.x0, y0, r.x1, y0 + 1) === 0) y0++
    while (y1 > y0 && S(r.x0, y1 - 1, r.x1, y1) === 0) y1--
    if (x1 - x0 < minSide || y1 - y0 < minSide) return null
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }
  const ps = out.map(trim).filter(Boolean)
  return ps.length >= 2 ? orderManga(ps, w, h) : null
}

export function detectPanels(img, opts = {}) {
  const maxW = opts.maxW || 700
  const iw = img.naturalWidth, ih = img.naturalHeight
  if (!iw || !ih) return null
  const s = Math.min(1, maxW / iw)
  const w = Math.max(1, Math.round(iw * s)), h = Math.max(1, Math.round(ih * s))
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  try { ctx.drawImage(img, 0, 0, w, h) } catch { return null }
  let px
  try { px = ctx.getImageData(0, 0, w, h).data } catch { return null }
  const N = w * h
  const whole = [{ x: 0, y: 0, w: 1, h: 1 }]

  // couleur de fond = moyenne du cadre extérieur (gouttière blanche OU sombre)
  let br = 0, bg = 0, bb = 0, bn = 0
  const acc = (x, y) => { const i = (y * w + x) * 4; br += px[i]; bg += px[i + 1]; bb += px[i + 2]; bn++ }
  for (let x = 0; x < w; x++) { acc(x, 0); acc(x, h - 1) }
  for (let y = 0; y < h; y++) { acc(0, y); acc(w - 1, y) }
  br /= bn; bg /= bn; bb /= bn
  const TOL = 48

  // masque d'encre brut (1 = pas le fond) — sert au repli X-Y cut
  const raw = new Uint8Array(N)
  for (let k = 0; k < N; k++) {
    const i = k * 4
    raw[k] = (Math.abs(px[i] - br) < TOL && Math.abs(px[i + 1] - bg) < TOL && Math.abs(px[i + 2] - bb) < TOL) ? 0 : 1
  }
  // DILATATION de l'encre → soude les trames (fonds clairs/texturés ne sont plus traversables)
  const DIL = 2
  let content = raw
  for (let it = 0; it < DIL; it++) {
    const nx = new Uint8Array(N)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = y * w + x
      if (content[k] || (x > 0 && content[k - 1]) || (x < w - 1 && content[k + 1]) || (y > 0 && content[k - w]) || (y < h - 1 && content[k + w])) nx[k] = 1
    }
    content = nx
  }

  // 2) flood-fill du fond depuis les bords → masque gouttière
  const gutter = new Uint8Array(N)
  const st = new Int32Array(N)
  let sp = 0
  const seed = (k) => { if (!gutter[k] && content[k] === 0) { gutter[k] = 1; st[sp++] = k } }
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1) }
  while (sp > 0) {
    const k = st[--sp], x = k % w, y = (k / w) | 0
    if (x > 0) seed(k - 1); if (x < w - 1) seed(k + 1)
    if (y > 0) seed(k - w); if (y < h - 1) seed(k + w)
  }

  // 3) composantes connexes des pixels NON-gouttière = cases candidates
  const seen = new Uint8Array(N)
  const q = new Int32Array(N)
  const minArea = N * 0.008, minSide = Math.min(w, h) * 0.05
  let rects = []
  for (let k0 = 0; k0 < N; k0++) {
    if (gutter[k0] || seen[k0]) continue
    let head = 0, tail = 0
    q[tail++] = k0; seen[k0] = 1
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0
    while (head < tail) {
      const k = q[head++], x = k % w, y = (k / w) | 0
      area++
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
      if (x > 0 && !gutter[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; q[tail++] = k - 1 }
      if (x < w - 1 && !gutter[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; q[tail++] = k + 1 }
      if (y > 0 && !gutter[k - w] && !seen[k - w]) { seen[k - w] = 1; q[tail++] = k - w }
      if (y < h - 1 && !gutter[k + w] && !seen[k + w]) { seen[k + w] = 1; q[tail++] = k + w }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, fill = area / (bw * bh)
    if (area >= minArea && bw >= minSide && bh >= minSide && fill >= 0.18) rects.push({ x: x0, y: y0, w: bw, h: bh })
  }
  rects = rects.filter((r) => r.w * r.h < w * h * 0.96)

  // Choix : la segmentation si elle a trouvé ≥2 cases, sinon repli X-Y cut (fond perdu), sinon planche entière
  if (rects.length >= 2) return orderManga(rects, w, h)
  return xyCut(raw, w, h) || whole
}
