// Détection des cases (panels) d'une planche de MANGA, ordonnées en sens de lecture
// droite→gauche puis haut→bas. Analyse en canvas (images même origine → pas de taint),
// algorithme X-Y cut : on coupe récursivement le long des gouttières (bandes blanches).
// Sans ML, volontairement robuste et dégradant proprement (repli = planche entière).

// Table des sommes cumulées (summed-area table) du masque "contenu" → somme d'un rectangle en O(1).
function buildSAT(content, w, h) {
  const sat = new Int32Array((w + 1) * (h + 1))
  const sw = w + 1
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    for (let x = 0; x < w; x++) {
      rowSum += content[y * w + x]
      sat[(y + 1) * sw + (x + 1)] = sat[y * sw + (x + 1)] + rowSum
    }
  }
  return sat
}
function rectSum(sat, sw, x0, y0, x1, y1) {
  return sat[y1 * sw + x1] - sat[y0 * sw + x1] - sat[y1 * sw + x0] + sat[y0 * sw + x0]
}

// Plus large "trou" intérieur (run où isEmpty(i) est vrai), ne touchant pas les bords [lo,hi).
function biggestGap(lo, hi, isEmpty, minRun) {
  let best = null, i = lo
  while (i < hi) {
    if (!isEmpty(i)) { i++; continue }
    let j = i
    while (j < hi && isEmpty(j)) j++
    const touchesBorder = (i === lo) || (j === hi)
    const size = j - i
    if (!touchesBorder && size >= minRun && (!best || size > best.size)) {
      best = { start: i, end: j, size }
    }
    i = j
  }
  return best
}

// Rogne un rectangle sur son contenu réel (enlève les marges blanches). null si vide.
function trim(sat, sw, w, h, r) {
  const colHas = (x) => rectSum(sat, sw, x, r.y0, x + 1, r.y1) > 0
  const rowHas = (y) => rectSum(sat, sw, r.x0, y, r.x1, y + 1) > 0
  let x0 = r.x0, x1 = r.x1, y0 = r.y0, y1 = r.y1
  while (x0 < x1 && !colHas(x0)) x0++
  while (x1 > x0 && !colHas(x1 - 1)) x1--
  while (y0 < y1 && !rowHas(y0)) y0++
  while (y1 > y0 && !rowHas(y1 - 1)) y1--
  if (x1 - x0 < 2 || y1 - y0 < 2) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function detectPanels(img, opts = {}) {
  const maxW = opts.maxW || 820
  const iw = img.naturalWidth, ih = img.naturalHeight
  if (!iw || !ih) return null
  const s = Math.min(1, maxW / iw)
  const w = Math.max(1, Math.round(iw * s)), h = Math.max(1, Math.round(ih * s))
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  try { ctx.drawImage(img, 0, 0, w, h) } catch { return null }
  let px
  try { px = ctx.getImageData(0, 0, w, h).data } catch { return null }  // cross-origin taint → abandon

  // "contenu" = pixel ni quasi-blanc uni (gouttière) : sombre OU coloré.
  const content = new Uint8Array(w * h)
  for (let k = 0; k < w * h; k++) {
    const i = k * 4
    const r = px[i], g = px[i + 1], b = px[i + 2]
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    content[k] = (mx < 232 || (mx - mn) > 28) ? 1 : 0
  }
  const sat = buildSAT(content, w, h)
  const sw = w + 1

  const minSide = Math.min(w, h)
  const minPanel = minSide * 0.12
  const gutterFrac = 0.010                        // ligne/colonne "vide" si < 1% de contenu
  const minGutter = Math.max(4, Math.round(minSide * 0.012))

  const out = []
  const stack = [{ x0: 0, y0: 0, x1: w, y1: h, depth: 0 }]
  while (stack.length) {
    const r = stack.pop()
    const bw = r.x1 - r.x0, bh = r.y1 - r.y0
    if (bw < minPanel || bh < minPanel || r.depth > 9) { out.push(r); continue }
    const rowThresh = bw * gutterFrac
    const colThresh = bh * gutterFrac
    const hGap = biggestGap(r.y0, r.y1, (y) => rectSum(sat, sw, r.x0, y, r.x1, y + 1) <= rowThresh, minGutter)
    const vGap = biggestGap(r.x0, r.x1, (x) => rectSum(sat, sw, x, r.y0, x + 1, r.y1) <= colThresh, minGutter)
    if (hGap && (!vGap || hGap.size >= vGap.size)) {
      stack.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: hGap.start, depth: r.depth + 1 })
      stack.push({ x0: r.x0, y0: hGap.end, x1: r.x1, y1: r.y1, depth: r.depth + 1 })
    } else if (vGap) {
      stack.push({ x0: r.x0, y0: r.y0, x1: vGap.start, y1: r.y1, depth: r.depth + 1 })
      stack.push({ x0: vGap.end, y0: r.y0, x1: r.x1, y1: r.y1, depth: r.depth + 1 })
    } else {
      out.push(r)
    }
  }

  let panels = out.map((r) => trim(sat, sw, w, h, r)).filter(Boolean)
  // fusion des micro-cases dans un voisin (bruit) : on jette les trop petites
  panels = panels.filter((p) => p.w >= minPanel * 0.6 && p.h >= minPanel * 0.6)
  if (panels.length === 0) panels = [{ x: 0, y: 0, w, h }]

  // ORDRE MANGA : bande par bande (haut→bas), droite→gauche dans une bande.
  panels.sort((a, b) => {
    const ca = a.y + a.h / 2, cb = b.y + b.h / 2
    if (Math.abs(ca - cb) > Math.min(a.h, b.h) * 0.5) return ca - cb   // bandes différentes → plus haut d'abord
    return (b.x + b.w / 2) - (a.x + a.w / 2)                           // même bande → plus à droite d'abord
  })

  // fractions [0..1] de l'image (indépendant de l'échelle d'affichage)
  return panels.map((p) => ({ x: p.x / w, y: p.y / h, w: p.w / w, h: p.h / h }))
}
