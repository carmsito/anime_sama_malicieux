// Moteur d'ambiance sonore SYNTHÉTISÉ en Web Audio — aucun fichier audio (léger).
// Chaque ambiance = un petit graphe de bruit filtré / drones. Changement de segment →
// crossfade (rampe de gain) doux. Le son ne démarre qu'après un geste utilisateur
// (contrainte navigateur) : on appelle resume() sur le 1er toggle.

const FADE = 1.6 // s de fondu enchaîné entre ambiances

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
  let ctx = null, master = null, cur = null, curLabel = null, vol = 0.5

  const ensure = () => {
    if (ctx) return
    ctx = new (window.AudioContext || window.webkitAudioContext)()
    master = ctx.createGain(); master.gain.value = vol; master.connect(ctx.destination)
  }

  return {
    async enable() { ensure(); if (ctx.state === 'suspended') await ctx.resume() },
    setVolume(v) { vol = v; if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.1) },
    set(label) {
      if (!ctx || label === curLabel) return
      curLabel = label
      const t = ctx.currentTime
      const next = build(ctx, label || 'interieur')
      next.out.connect(master)
      next.out.gain.setValueAtTime(0.0001, t)
      next.out.gain.exponentialRampToValueAtTime(1, t + FADE)
      const prev = cur
      if (prev) {
        prev.out.gain.setValueAtTime(prev.out.gain.value || 1, t)
        prev.out.gain.exponentialRampToValueAtTime(0.0001, t + FADE)
        setTimeout(() => { try { prev.stop(); prev.out.disconnect() } catch { /* noop */ } }, (FADE + 0.3) * 1000)
      }
      cur = next
    },
    stop() {
      curLabel = null
      if (cur) { const p = cur; cur = null; try { p.out.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.3); setTimeout(() => { p.stop(); p.out.disconnect() }, 600) } catch { /* noop */ } }
      if (ctx && ctx.state === 'running') ctx.suspend()
    },
  }
}
