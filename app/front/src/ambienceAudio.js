// Moteur d'ambiance sonore. Les DÉCORS jouent de vraies boucles audio (extraits ~3 min
// découpés de vidéos d'ambiance, encodés en Opus → /ambience/<label>.opus). Ce qui n'a
// pas de piste reste SYNTHÉTISÉ en Web Audio : « feu » (crépitement) et la couche de
// tension « action » (bruit brun « focus »). Si un fichier manque (piste absente ou
// hors-ligne avant mise en cache), la couche RETOMBE sur la synthèse plutôt que le silence.
// Le moteur MIXE plusieurs couches en même temps (ex. « foret » + « action ») avec un
// crossfade (rampe de gain) doux. Le son ne démarre qu'après un geste utilisateur
// (contrainte navigateur) : on appelle resume() au 1er toggle.

const FADE = 1.6 // s de fondu enchaîné entre couches

// Décors qui disposent d'un extrait audio réel dans /ambience/<label>.opus.
// Tout le reste (feu, action, inconnu) est synthétisé ci-dessous.
const FILE_LAYERS = new Set([
  'pluie', 'neige', 'ocean', 'foret', 'foule', 'ville', 'interieur', 'nuit', 'exterieur',
])
const fileUrl = (label) => `/ambience/${label}.opus`

function noiseBuffer(ctx, kind = 'white', seconds = 4) {
  const n = ctx.sampleRate * seconds
  const buf = ctx.createBuffer(1, n, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let last = 0
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1
    if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5 }
    else if (kind === 'pink') { last = 0.98 * last + 0.02 * w; d[i] = (w * 0.4 + last) }
    else d[i] = w
  }
  return buf
}

function source(ctx, buf, loop = true) {
  const s = ctx.createBufferSource(); s.buffer = buf; s.loop = loop; s.start(); return s
}

// Construit un sous-graphe SYNTHÉTISÉ dans `out`. Retourne les nœuds à arrêter.
function synthInto(ctx, out, label) {
  const parts = []
  const add = (node) => { parts.push(node); return node }
  const lfo = (freq, depth, target, base = 0) => {
    const o = add(ctx.createOscillator()); o.frequency.value = freq
    const g = add(ctx.createGain()); g.gain.value = depth
    o.connect(g); g.connect(target); target.value = base; o.start(); return o
  }

  if (label === 'feu') {
    const s = add(source(ctx, noiseBuffer(ctx, 'brown')))
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900
    s.connect(lp); lp.connect(out)              // grondement du feu
    const cr = add(source(ctx, noiseBuffer(ctx, 'white')))  // crépitements
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000
    const cg = ctx.createGain(); cg.gain.value = 0.15
    cr.connect(hp); hp.connect(cg); cg.connect(out)
    lfo(7, 0.14, cg.gain, 0.15)                 // pétillement irrégulier
  } else if (label === 'action') {
    // COUCHE de tension « FOCUS » : bruit brun grave et STABLE (pas de rythme), qui
    // respire lentement → impression de concentration/tension. Pensée pour se SUPERPOSER
    // discrètement à un décor (foret+action, exterieur+action…).
    const r = add(source(ctx, noiseBuffer(ctx, 'brown')))
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 240; lp.Q.value = 0.7
    const rg = ctx.createGain(); rg.gain.value = 0.9
    r.connect(lp); lp.connect(rg); rg.connect(out)
    lfo(0.06, 0.25, rg.gain, 0.9)               // très lente respiration (focus qui pulse)
  } else if (label === 'ocean') {
    // Repli si l'extrait « ocean » manque : vagues synthétisées (bruit brun + houle lente).
    const s = add(source(ctx, noiseBuffer(ctx, 'brown')))
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600
    const swell = ctx.createGain(); swell.gain.value = 0.5
    s.connect(lp); lp.connect(swell); swell.connect(out)
    lfo(0.1, 0.4, swell.gain, 0.5)              // vagues
  } else { // repli générique : room tone très discret
    const s = add(source(ctx, noiseBuffer(ctx, 'pink')))
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400
    const soft = ctx.createGain(); soft.gain.value = 0.12
    s.connect(lp); lp.connect(soft); soft.connect(out)
  }
  return parts
}

function stopParts(parts) {
  parts.forEach((p) => { try { p.stop && p.stop() } catch { /* noop */ } })
}

// Boucle audio RÉELLE : GainNode dispo tout de suite (pour le fondu). Dès que le buffer
// est décodé (fetch async) on démarre la source ; s'il manque → repli synthé dans le même
// GainNode. `level` = gain cible de la couche.
function buildFile(ctx, label, getBuffer) {
  const out = ctx.createGain(); out.gain.value = 0
  let src = null, stopped = false, syn = []
  getBuffer(label).then((buf) => {
    if (stopped) return
    if (buf) { src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.connect(out); src.start() }
    else { syn = synthInto(ctx, out, label) }   // fichier absent → repli synthé
  }).catch(() => {})
  return {
    out, level: 1,
    stop() { stopped = true; try { src && src.stop() } catch { /* noop */ } stopParts(syn) },
  }
}

function buildSynth(ctx, label) {
  const out = ctx.createGain(); out.gain.value = 0
  const parts = synthInto(ctx, out, label)
  // « action » plus discrète que les décors pour ne pas écraser le mix.
  return { out, level: label === 'action' ? 0.55 : 0.7, stop() { stopParts(parts) } }
}

function build(ctx, label, getBuffer) {
  return FILE_LAYERS.has(label) ? buildFile(ctx, label, getBuffer) : buildSynth(ctx, label)
}

export function createAmbienceEngine() {
  let ctx = null, master = null, vol = 0.5
  const layers = new Map()   // label -> { out, level, stop }
  const buffers = new Map()  // label -> Promise<AudioBuffer|null> (décodage mis en cache)

  const ensure = () => {
    if (ctx) return
    ctx = new (window.AudioContext || window.webkitAudioContext)()
    master = ctx.createGain(); master.gain.value = vol; master.connect(ctx.destination)
  }

  // Décode (et met en cache) la boucle audio d'un décor. Le SW garde le fichier en cache
  // → instantané aux relectures / hors-ligne. null si absent (→ repli synthé).
  const getBuffer = (label) => {
    if (!buffers.has(label)) {
      const p = fetch(fileUrl(label))
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('404'))))
        .then((ab) => ctx.decodeAudioData(ab))
        .catch(() => null)
      buffers.set(label, p)
    }
    return buffers.get(label)
  }

  const fadeIn = (node) => {
    const t = ctx.currentTime
    node.out.connect(master)
    node.out.gain.setValueAtTime(0.0001, t)
    node.out.gain.exponentialRampToValueAtTime(node.level || 1, t + FADE)
  }
  const fadeOut = (node) => {
    const t = ctx.currentTime
    try {
      node.out.gain.setValueAtTime(node.out.gain.value || 1, t)
      node.out.gain.exponentialRampToValueAtTime(0.0001, t + FADE)
    } catch { /* noop */ }
    setTimeout(() => { try { node.stop(); node.out.disconnect() } catch { /* noop */ } }, (FADE + 0.3) * 1000)
  }

  // Applique l'ENSEMBLE de couches voulu : ajoute les nouvelles, retire les disparues,
  // laisse en place celles qui persistent (pas de re-fondu inutile → mix stable).
  const apply = (arr) => {
    if (!ctx) return
    const want = new Set(arr && arr.length ? arr : ['interieur'])
    for (const [label, node] of layers) {
      if (!want.has(label)) { fadeOut(node); layers.delete(label) }
    }
    for (const label of want) {
      if (!layers.has(label)) { const n = build(ctx, label, getBuffer); fadeIn(n); layers.set(label, n) }
    }
  }

  return {
    async enable() { ensure(); if (ctx.state === 'suspended') await ctx.resume() },
    setVolume(v) { vol = v; if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.1) },
    setLayers(arr) { apply(arr) },
    set(label) { apply([label || 'interieur']) }, // compat : une seule ambiance
    stop() {
      for (const [label, node] of layers) { fadeOut(node); layers.delete(label) }
      if (ctx && ctx.state === 'running') ctx.suspend()
    },
  }
}
