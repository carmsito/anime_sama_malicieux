// Moteur d'ambiance sonore SYNTHÉTISÉ en Web Audio — aucun fichier audio (léger).
// Chaque ambiance = un petit graphe de bruit filtré / drones. Le moteur MIXE plusieurs
// couches simultanément (ex. « foret » + « action », « nuit » + « pluie ») et fait un
// crossfade (rampe de gain) doux quand une couche apparaît/disparaît. Le son ne démarre
// qu'après un geste utilisateur (contrainte navigateur) : on appelle resume() au 1er toggle.

const FADE = 1.6 // s de fondu enchaîné entre couches

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

function source(ctx, buf) {
  const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s
}

// Retourne { out (GainNode), stop() } — un sous-graphe qui synthétise `label`.
function build(ctx, label) {
  const out = ctx.createGain(); out.gain.value = 0
  const parts = []
  const add = (node) => { parts.push(node); return node }

  const lfo = (freq, depth, target, base = 0) => {
    const o = add(ctx.createOscillator()); o.frequency.value = freq
    const g = add(ctx.createGain()); g.gain.value = depth
    o.connect(g); g.connect(target); target.value = base; o.start(); return o
  }

  if (label === 'pluie' || label === 'neige') {
    const s = add(source(ctx, noiseBuffer(ctx, 'white')))
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = label === 'neige' ? 600 : 1200
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 8000
    s.connect(hp); hp.connect(lp); lp.connect(out)
  } else if (label === 'ocean') {
    const s = add(source(ctx, noiseBuffer(ctx, 'brown')))
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600
    const swell = ctx.createGain(); swell.gain.value = 0.5
    s.connect(lp); lp.connect(swell); swell.connect(out)
    lfo(0.1, 0.4, swell.gain, 0.5) // vagues
  } else if (label === 'foret' || label === 'exterieur' || label === 'montagne' || label === 'ciel') {
    const s = add(source(ctx, noiseBuffer(ctx, 'brown')))
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.7
    s.connect(bp); bp.connect(out)
    lfo(0.08, 300, bp.frequency, 500) // vent qui module (forêt / plein air)
  } else if (label === 'feu') {
    const s = add(source(ctx, noiseBuffer(ctx, 'brown')))
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900
    s.connect(lp); lp.connect(out)              // grondement du feu
    const cr = add(source(ctx, noiseBuffer(ctx, 'white')))  // crépitements
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000
    const cg = ctx.createGain(); cg.gain.value = 0.15
    cr.connect(hp); hp.connect(cg); cg.connect(out)
    lfo(7, 0.14, cg.gain, 0.15)                 // pétillement irrégulier
  } else if (label === 'ville') {
    const s = add(source(ctx, noiseBuffer(ctx, 'brown')))
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220
    s.connect(lp); lp.connect(out) // rumble urbain sourd
  } else if (label === 'foule') {
    const s = add(source(ctx, noiseBuffer(ctx, 'pink')))
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.9
    s.connect(bp); bp.connect(out)
    lfo(0.5, 400, bp.frequency, 900) // brouhaha
  } else if (label === 'nuit') {
    const s = add(source(ctx, noiseBuffer(ctx, 'brown')))
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300
    const soft = ctx.createGain(); soft.gain.value = 0.25
    s.connect(lp); lp.connect(soft); soft.connect(out)
    const drone = add(ctx.createOscillator()); drone.type = 'sine'; drone.frequency.value = 55
    const dg = ctx.createGain(); dg.gain.value = 0.06; drone.connect(dg); dg.connect(out); drone.start()
  } else if (label === 'action') {
    // COUCHE de tension (combat / mouvement) : grondement bas + pulsation rythmique.
    // Pensée pour se SUPERPOSER à un décor (foret+action, exterieur+action…).
    const r = add(source(ctx, noiseBuffer(ctx, 'brown')))
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180
    const rg = ctx.createGain(); rg.gain.value = 0.3
    r.connect(lp); lp.connect(rg); rg.connect(out)          // grondement sourd
    const p = add(source(ctx, noiseBuffer(ctx, 'white')))
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 320; bp.Q.value = 1.2
    const pg = ctx.createGain(); pg.gain.value = 0.06
    p.connect(bp); bp.connect(pg); pg.connect(out)
    lfo(2.2, 0.16, pg.gain, 0.06)                           // battement ~130 bpm
  } else { // interieur / défaut : room tone très discret
    const s = add(source(ctx, noiseBuffer(ctx, 'pink')))
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400
    const soft = ctx.createGain(); soft.gain.value = 0.12
    s.connect(lp); lp.connect(soft); soft.connect(out)
  }

  return {
    out,
    stop() { parts.forEach((p) => { try { p.stop && p.stop() } catch { /* noop */ } }) },
  }
}

export function createAmbienceEngine() {
  let ctx = null, master = null, vol = 0.5
  const layers = new Map() // label -> { out, stop }

  const ensure = () => {
    if (ctx) return
    ctx = new (window.AudioContext || window.webkitAudioContext)()
    master = ctx.createGain(); master.gain.value = vol; master.connect(ctx.destination)
  }

  const fadeIn = (node) => {
    const t = ctx.currentTime
    node.out.connect(master)
    node.out.gain.setValueAtTime(0.0001, t)
    node.out.gain.exponentialRampToValueAtTime(1, t + FADE)
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
      if (!layers.has(label)) { const n = build(ctx, label); fadeIn(n); layers.set(label, n) }
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
