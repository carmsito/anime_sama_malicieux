// Détection des cases (panels) d'une planche de MANGA, en sens de lecture droite→gauche
// puis haut→bas. Analyse canvas (images même origine → pas de taint), SANS ML, SANS son.
//
// Approche par SEGMENTATION (façon Kumiko), bien plus robuste que l'X-Y cut pour les mises
// en page complexes du manga (cases qui en chevauchent d'autres, gouttières diagonales) :
//   1) couleur de fond = moyenne du cadre extérieur (marche gouttière blanche OU sombre) ;
//   2) flood-fill du fond depuis les bords → masque « gouttière » (l'espace entre les cases) ;
//   3) composantes connexes des pixels NON-gouttière = les cases (chaque case est un bloc
//      plein bordé de gouttière, quelle que soit sa forme) ;
//   4) filtres (taille, taux de remplissage → élimine le cadre fin), fusion des imbriquées ;
//   5) regroupement en RANGÉES par chevauchement vertical → ordre manga (rangée haut→bas,
//      droite→gauche dans la rangée).
// Repli propre : si on ne trouve pas ≥2 cases fiables → planche entière (1 case).

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
  try { px = ctx.getImageData(0, 0, w, h).data } catch { return null }   // cross-origin → abandon
  const N = w * h
  const whole = [{ x: 0, y: 0, w: 1, h: 1 }]

  // 1) couleur de fond (gouttière) = moyenne du cadre extérieur
  let br = 0, bg = 0, bb = 0, bn = 0
  const acc = (x, y) => { const i = (y * w + x) * 4; br += px[i]; bg += px[i + 1]; bb += px[i + 2]; bn++ }
  for (let x = 0; x < w; x++) { acc(x, 0); acc(x, h - 1) }
  for (let y = 0; y < h; y++) { acc(0, y); acc(w - 1, y) }
  br /= bn; bg /= bn; bb /= bn
  const TOL = 48
  // masque « encre » (tout ce qui n'est pas le fond) puis DILATATION : soude les trames des
  // panneaux à fond clair/texturé → leur intérieur cesse d'être « traversable » par le flood,
  // donc n'est plus absorbé dans la gouttière (fix cases claires manquantes). Les vraies
  // gouttières (larges, sans encre) restent traversables.
  const DIL = 2
  let content = new Uint8Array(N)
  for (let k = 0; k < N; k++) {
    const i = k * 4
    content[k] = (Math.abs(px[i] - br) < TOL && Math.abs(px[i + 1] - bg) < TOL && Math.abs(px[i + 2] - bb) < TOL) ? 0 : 1
  }
  for (let it = 0; it < DIL; it++) {
    const nx = new Uint8Array(N)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x
        if (content[k] || (x > 0 && content[k - 1]) || (x < w - 1 && content[k + 1]) || (y > 0 && content[k - w]) || (y < h - 1 && content[k + w])) nx[k] = 1
      }
    }
    content = nx
  }

  // 2) flood-fill du fond depuis tous les bords → masque gouttière (à travers les zones vides)
  const gutter = new Uint8Array(N)
  const st = new Int32Array(N)
  let sp = 0
  const seed = (k) => { if (!gutter[k] && content[k] === 0) { gutter[k] = 1; st[sp++] = k } }
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1) }
  while (sp > 0) {
    const k = st[--sp], x = k % w, y = (k / w) | 0
    if (x > 0) seed(k - 1)
    if (x < w - 1) seed(k + 1)
    if (y > 0) seed(k - w)
    if (y < h - 1) seed(k + w)
  }

  // 3) composantes connexes des pixels NON-gouttière = cases candidates
  const seen = new Uint8Array(N)
  const q = new Int32Array(N)
  const minArea = N * 0.008
  const minSide = Math.min(w, h) * 0.05   // tolère les cases fines (bandeaux larges, longues verticales)
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
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1
    const fill = area / (bw * bh)
    // 4) filtres : assez grande, et pas un contour fin creux (cadre → très faible remplissage).
    // fill bas toléré (0.18) pour garder les cases claires/peu encrées ou en L ; le cadre de page
    // a un remplissage quasi nul (< 0.05) → écarté quand même.
    if (area >= minArea && bw >= minSide && bh >= minSide && fill >= 0.18) {
      rects.push({ x: x0, y: y0, w: bw, h: bh, area })
    }
  }

  if (rects.length < 2) return whole   // rien de fiable (bleed, borderless…) → planche entière

  // 4b) jette seulement une case qui couvre quasi toute la page (cadre/fond résiduel).
  // (Les composantes sont DÉJÀ disjointes → PAS de dé-doublonnage par imbrication : une grosse
  //  case en L a une grande boîte qui peut contenir la boîte d'une vraie case voisine.)
  const pageArea = w * h
  rects = rects.filter((r) => r.w * r.h < pageArea * 0.96)
  if (rects.length < 2) return whole

  // 5) regroupement en rangées (chevauchement vertical) → ordre manga
  const byTop = [...rects].sort((a, b) => a.y - b.y)
  const rows = []
  for (const p of byTop) {
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
  const ordered = []
  for (const r of rows) {
    r.items.sort((a, b) => (b.x + b.w) - (a.x + a.w))   // droite→gauche (sens manga)
    ordered.push(...r.items)
  }

  // fractions [0..1] de l'image
  return ordered.map((p) => ({ x: p.x / w, y: p.y / h, w: p.w / w, h: p.h / h }))
}
