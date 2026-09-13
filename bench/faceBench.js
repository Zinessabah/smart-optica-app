/**
 * BANC DE MESURE — détection automatique des 3 mires faciales
 *
 * Principe : on dessine des visages synthétiques à ÉCHELLE PHYSIQUE RÉELLE
 * (1 mm = 20 px, image 3024×4032 = les dimensions d'une photo d'iPad), dont les
 * pupilles et le pont sont connus AU PIXEL près. On passe ensuite ces images dans
 * la VRAIE cascade de l'application (`src/core/faceDetection.js`) et on compare.
 *
 * Toutes les erreurs sont exprimées en millimètres, la seule unité qui compte.
 * Aucune estimation : la vérité terrain est la position avec laquelle on a dessiné.
 */
import { detectFace } from '../src/core/faceDetection.js'

const MM = 20                    // px par millimètre
const W = 3024, H = 4032         // px — dimensions d'une photo d'iPad
const MM_IPD = 63                // écart pupillaire humain moyen
const EYE_W = 31, EYE_H = 11     // ouverture palpébrale (mm)
const IRIS_R = 6.2, PUPIL_R = 2.1

const rot = (p, c, deg) => {
  const a = deg * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a)
  const dx = p.x - c.x, dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const mm = (px) => px / MM

// ─────────────────────────── Visage synthétique ───────────────────────────
function makeFace({ eyeOpen = 1, faceW = 2900, cx = W / 2, cy = H * 0.42, roll = 0, glasses = false, dim = 1 }) {
  const c = { x: cx, y: cy }
  const ipd = MM_IPD * MM
  const eyeY = -0.055 * faceW

  // Vérité terrain (coordonnées globales, après rotation)
  const gt = {
    pupilL: rot({ x: cx - ipd / 2, y: cy + eyeY }, c, roll),
    pupilR: rot({ x: cx + ipd / 2, y: cy + eyeY }, c, roll),
    nose:   rot({ x: cx,             y: cy + eyeY + 4 * MM }, c, roll),
  }

  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const g = cv.getContext('2d')

  g.fillStyle = '#3a3f47'; g.fillRect(0, 0, W, H)

  g.save()
  g.translate(cx, cy); g.rotate(roll * Math.PI / 180)

  const fh = faceW * 1.34
  // Tête
  const skin = g.createRadialGradient(0, -faceW * 0.12, faceW * 0.1, 0, 0, faceW * 0.85)
  skin.addColorStop(0, '#e8c39a'); skin.addColorStop(0.65, '#d3a578'); skin.addColorStop(1, '#a9764f')
  g.fillStyle = skin
  g.beginPath(); g.ellipse(0, 0, faceW / 2, fh / 2, 0, 0, Math.PI * 2); g.fill()

  // Texturé de peau (bruit léger, pour ne pas avoir un aplat irréaliste)
  for (let i = 0; i < 2600; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random())
    const px = Math.cos(a) * r * faceW / 2, py = Math.sin(a) * r * fh / 2
    g.fillStyle = `rgba(${120 + Math.random() * 60 | 0},${85 + Math.random() * 40 | 0},${60 + Math.random() * 30 | 0},0.10)`
    g.beginPath(); g.arc(px, py, 2 + Math.random() * 7, 0, Math.PI * 2); g.fill()
  }

  // Sourcils
  g.strokeStyle = '#4a3020'; g.lineCap = 'round'
  g.lineWidth = 0.013 * faceW
  for (const s of [-1, 1]) {
    g.beginPath()
    g.moveTo(s * (ipd / 2 - EYE_W * MM * 0.42), eyeY - EYE_H * MM * 0.85)
    g.quadraticCurveTo(s * ipd / 2, eyeY - EYE_H * MM * 1.5, s * (ipd / 2 + EYE_W * MM * 0.5), eyeY - EYE_H * MM * 0.75)
    g.stroke()
  }

  // Yeux
  const rxE = EYE_W * MM / 2, ryE = (EYE_H * MM / 2) * eyeOpen
  for (const s of [-1, 1]) {
    const ex = s * ipd / 2
    // Ombre orbitaire
    g.fillStyle = 'rgba(120,80,55,0.35)'
    g.beginPath(); g.ellipse(ex, eyeY, rxE * 1.25, ryE * 1.9, 0, 0, Math.PI * 2); g.fill()

    g.save()
    g.beginPath(); g.ellipse(ex, eyeY, rxE, ryE, 0, 0, Math.PI * 2); g.clip()
    // Sclère
    g.fillStyle = '#f4f0e9'
    g.beginPath(); g.ellipse(ex, eyeY, rxE, ryE, 0, 0, Math.PI * 2); g.fill()
    // Iris + pupille : centres EXACTEMENT sur la vérité terrain
    const ir = IRIS_R * MM, pr = PUPIL_R * MM
    const iris = g.createRadialGradient(ex, eyeY, pr * 0.6, ex, eyeY, ir)
    iris.addColorStop(0, '#2b1d12'); iris.addColorStop(0.55, '#4e6b3c'); iris.addColorStop(1, '#1e1608')
    g.fillStyle = iris
    g.beginPath(); g.arc(ex, eyeY, ir, 0, Math.PI * 2); g.fill()
    g.fillStyle = '#0a0705'
    g.beginPath(); g.arc(ex, eyeY, pr, 0, Math.PI * 2); g.fill()
    // Reflet spéculaire (contre-épreuve : il ne doit pas déplacer le centroïde)
    g.fillStyle = 'rgba(255,255,255,0.85)'
    g.beginPath(); g.arc(ex - pr * 0.45, eyeY - pr * 0.45, pr * 0.34, 0, Math.PI * 2); g.fill()
    g.restore()

    // Paupières (trait)
    g.strokeStyle = 'rgba(70,45,30,0.85)'; g.lineWidth = 0.004 * faceW
    g.beginPath(); g.ellipse(ex, eyeY, rxE, ryE, 0, 0, Math.PI * 2); g.stroke()
  }

  // Nez : arête + ailes
  g.strokeStyle = 'rgba(150,100,70,0.55)'; g.lineWidth = 0.006 * faceW
  g.beginPath(); g.moveTo(-faceW * 0.012, eyeY + 5 * MM); g.lineTo(-faceW * 0.03, 0.09 * faceW); g.stroke()
  g.beginPath(); g.moveTo(faceW * 0.012, eyeY + 5 * MM); g.lineTo(faceW * 0.03, 0.09 * faceW); g.stroke()
  g.fillStyle = 'rgba(110,70,50,0.5)'
  for (const s of [-1, 1]) {
    g.beginPath(); g.ellipse(s * faceW * 0.038, 0.105 * faceW, faceW * 0.016, faceW * 0.011, 0, 0, Math.PI * 2); g.fill()
  }

  // Bouche
  g.strokeStyle = 'rgba(150,70,70,0.8)'; g.lineWidth = 0.008 * faceW
  g.beginPath(); g.moveTo(-faceW * 0.075, 0.235 * faceW)
  g.quadraticCurveTo(0, 0.26 * faceW, faceW * 0.075, 0.235 * faceW); g.stroke()

  // Lunettes
  if (glasses) {
    g.strokeStyle = '#2b2b30'; g.lineWidth = 0.006 * faceW
    for (const s of [-1, 1]) {
      g.beginPath(); g.roundRect(s * ipd / 2 - rxE * 1.35, eyeY - ryE * 1.7, rxE * 2.7, ryE * 3.4 + EYE_H * MM * 0.9, rxE * 0.35); g.stroke()
      g.fillStyle = 'rgba(200,225,240,0.10)'; g.fill()
    }
    g.beginPath(); g.moveTo(-rxE * 0.35, eyeY - ryE * 0.6); g.lineTo(rxE * 0.35, eyeY - ryE * 0.6); g.stroke()
  }

  g.restore()

  if (dim < 1) { g.fillStyle = `rgba(0,0,0,${1 - dim})`; g.fillRect(0, 0, W, H) }

  return { canvas: cv, gt }
}

// ────────────── Mesure de la pupille (piste proposée n°1) ──────────────
/** Centroïde des N % de pixels les plus sombres dans une boîte — cœur de la pupille. */
function darkestCentroid(g, box, pct) {
  const x0 = Math.max(0, Math.round(box.x)), y0 = Math.max(0, Math.round(box.y))
  const w = Math.min(W - x0, Math.round(box.w)), h = Math.min(H - y0, Math.round(box.h))
  if (w < 2 || h < 2) return null
  const d = g.getImageData(x0, y0, w, h).data
  const lum = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]
  }
  const sorted = Float32Array.from(lum).sort()
  const thr = sorted[Math.floor(sorted.length * pct / 100)]
  let sx = 0, sy = 0, n = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (lum[y * w + x] <= thr) { sx += x; sy += y; n++ }
  }
  if (!n) return null
  return { x: x0 + sx / n, y: y0 + sy / n }
}

// ─────────────────────────────── Mesure ───────────────────────────────
const loadImg = (cv) => new Promise((res) => {
  const i = new Image(); i.onload = () => res(i); i.src = cv.toDataURL('image/png')
})

async function measure(name, opts, label) {
  const { canvas, gt } = makeFace(opts)
  const img = await loadImg(canvas)
  const g = canvas.getContext('2d')
  const t0 = performance.now()
  const det = await detectFace(img, { width: W, height: H })
  const ms = performance.now() - t0

  // Association œil détecté ↔ pupille de vérité (par ordre horizontal)
  const eyes = [det.leftEye, det.rightEye].sort((a, b) => a.x - b.x)
  const gts = [gt.pupilL, gt.pupilR].sort((a, b) => a.x - b.x)

  // Piste 1 : centroïde du cœur le plus sombre dans la boîte de l'œil
  const pupils = eyes.map((e, i) => {
    const r = 26 * MM / 2                                   // boîte ≈ une ouverture palpébrale
    const p5 = darkestCentroid(g, { x: e.x - r, y: e.y - r * 0.8, w: r * 2, h: r * 1.6 }, 5)
    const p20 = darkestCentroid(g, { x: e.x - r, y: e.y - r * 0.8, w: r * 2, h: r * 1.6 }, 20)
    return { p5, p20, ref: gts[i] }
  })

  // Scores du détecteur aux seuils de l'app (0,5 par défaut) : pourquoi ça échoue
  let scores = {}
  try {
    const fa = await import('face-api.js')
    for (const size of [416, 608]) {
      const d = await fa.detectSingleFace(img, new fa.TinyFaceDetectorOptions({ inputSize: size }))
      scores[`s${size}`] = d ? +d.score.toFixed(3) : null
    }
  } catch { scores = { erreur: true } }

  const dpTrue = mm(dist(gt.pupilL, gt.pupilR))
  const dpDet = mm(dist(det.leftEye, det.rightEye))
  const dpP5 = pupils[0].p5 && pupils[1].p5 ? mm(dist(pupils[0].p5, pupils[1].p5)) : null

  return {
    name, label, method: det.method, ms: Math.round(ms), scores,
    detected: { od: det.leftEye, og: det.rightEye, nez: det.nose },
    gt,
    errMm: {
      od: +mm(dist(det.leftEye, gt.pupilL)).toFixed(2),
      og: +mm(dist(det.rightEye, gt.pupilR)).toFixed(2),
      nez: +mm(dist(det.nose, gt.nose)).toFixed(2),
    },
    pupilErrMm: {
      p5od: pupils[0].p5 ? +mm(dist(pupils[0].p5, pupils[0].ref)).toFixed(2) : null,
      p5og: pupils[1].p5 ? +mm(dist(pupils[1].p5, pupils[1].ref)).toFixed(2) : null,
      p20od: pupils[0].p20 ? +mm(dist(pupils[0].p20, pupils[0].ref)).toFixed(2) : null,
      p20og: pupils[1].p20 ? +mm(dist(pupils[1].p20, pupils[1].ref)).toFixed(2) : null,
    },
    erreurMesureMm: +mm(dpDet - dpTrue).toFixed(2),          // ← l'erreur sur la MESURE
    veriteMesureMm: +dpTrue.toFixed(2),
    canvas, pupils, eyes, gts,
  }
}

// ─────────────────────────── Scénarios ───────────────────────────
const VARIANTS = [
  ['reference',   { },                                              'Référence : visage frontal, yeux ouverts'],
  ['paupieres',   { eyeOpen: 0.5 },                                 'Yeux mi-clos (test du biais palpébral)'],
  ['petit',       { faceW: 900 },                                   'Visage petit dans l’image'],
  ['decale',      { cx: W * 0.30 },                                 'Visage décentré'],
  ['roulis',      { roll: 12 },                                     'Tête inclinée 12°'],
  ['lunettes',    { glasses: true },                                'Avec lunettes'],
  ['penombre',    { dim: 0.55 },                                    'Éclairage faible'],
]

// ── Captures des avertissements (face-api échoue en silence sinon) ──
const WARNS = []
for (const k of ['warn', 'error']) {
  const orig = console[k].bind(console)
  console[k] = (...a) => { WARNS.push(`${k}: ${a.map(String).join(' ')}`); orig(...a) }
}

/** Diagnostic : pourquoi la cascade s'arrête-t-elle si bas ? */
async function diag() {
  const L = []
  const push = (x) => { L.push(x); POST('diag_ligne', x) }
  const cv = makeFace({}).canvas
  const img = await loadImg(cv)
  let fa = null
  try {
    fa = await import('face-api.js')
    push(`tf backend : ${fa.tf ? fa.tf.getBackend() : 'inconnu'}`)
  } catch (e) { push(`import face-api : ECHEC ${e.message}`); return L }
  try {
    await fa.nets.tinyFaceDetector.loadFromUri('/models')
    await fa.nets.faceLandmark68Net.loadFromUri('/models')
    push('modèles locaux /models : OK')
  } catch (e) { push(`modèles locaux /models : ECHEC ${e.message}`) }
  for (const size of [320, 416, 608]) {
    try {
      const d = await fa.detectSingleFace(img, new fa.TinyFaceDetectorOptions({ inputSize: size, scoreThreshold: 0.2 }))
      push(`inputSize ${size} (seuil 0.2) : ${d ? `visage OK score=${d.score.toFixed(3)}` : 'AUCUN visage'}`)
    } catch (e) { push(`inputSize ${size} : ERREUR ${e.message}`) }
  }
  try {
    const f = await fa.detectSingleFace(img, new fa.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.2 }))
      .withFaceLandmarks()
    if (f) {
      const e1 = f.landmarks.getLeftEye()[0], e2 = f.landmarks.getRightEye()[0]
      push(`landmarks 68 : OK — 1er point œil gauche (${e1.x.toFixed(0)},${e1.y.toFixed(0)}), œil droit (${e2.x.toFixed(0)},${e2.y.toFixed(0)})`)
    } else push('landmarks 68 : aucun visage')
  } catch (e) { push(`landmarks 68 : ERREUR ${e.message}`) }
  return L
}

const POST = (stage, data) => {
  try {
    fetch('http://127.0.0.1:5199/r', {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage, data }),
    })
  } catch { /* banc : sans conséquence */ }
}

// Tout rejet non géré est remonté : c'est ce qui a révélé le défaut du modèle.
addEventListener('unhandledrejection', (e) => {
  POST('rejet', { message: String(e.reason && (e.reason.message || e.reason)), stack: String(e.reason && e.reason.stack || '').split('\n').slice(0, 4) })
})

const out = document.getElementById('out')
const vis = document.getElementById('vis')
const results = []
const log = (s) => { out.textContent = s }

let DIAG = []
try {
  log('Diagnostic en cours…')
  POST('debut', { })
  DIAG = await diag()
  POST('diagnostic', DIAG)
  log(`Diagnostic :\n${DIAG.join('\n')}\n\nMesure des scénarios…`)
  for (const [name, opts, label] of VARIANTS) {
    log(`En cours : ${name}…\n${JSON.stringify(results, null, 1)}`)
    const r = await measure(name, opts, label)
    results.push(r)

    // Vignette de preuve visuelle
    const v = document.createElement('canvas')
    const sc = 240 / W
    v.width = Math.round(W * sc); v.height = Math.round(H * sc)
    const vg = v.getContext('2d')
    vg.fillStyle = '#000'; vg.fillRect(0, 0, v.width, v.height)
    vg.drawImage(r.canvas, 0, 0, v.width, v.height)
    const cross = (p, col, s = 5) => {
      vg.strokeStyle = col; vg.lineWidth = 1.4
      vg.beginPath(); vg.moveTo(p.x * sc - s, p.y * sc); vg.lineTo(p.x * sc + s, p.y * sc)
      vg.moveTo(p.x * sc, p.y * sc - s); vg.lineTo(p.x * sc, p.y * sc + s); vg.stroke()
    }
    cross(r.gt.pupilL, '#0f0'); cross(r.gt.pupilR, '#0f0'); cross(r.gt.nose, '#0f0')
    cross(r.detected.od, '#f33'); cross(r.detected.og, '#f33'); cross(r.detected.nez, '#f33')
    r.pupils.forEach((p) => p.p5 && cross(p.p5, '#39f'))
    vg.fillStyle = '#fff'; vg.font = '11px monospace'
    vg.fillText(`${name} · ${r.method}`, 5, 13)
    vis.appendChild(v)
    POST('scenario', {
      name: r.name, label: r.label, method: r.method, ms: r.ms, scores: r.scores,
      detected: r.detected, gt: r.gt,
      errMm: r.errMm, pupilErrMm: r.pupilErrMm,
      erreurMesureMm: r.erreurMesureMm, veriteMesureMm: r.veriteMesureMm,
      vignette: v.toDataURL('image/png'),
    })
    r.canvas = null
  }

  const json = JSON.stringify(results, null, 1)
  log(`TERMINE\n=== DIAGNOSTIC ===\n${DIAG.join('\n')}\n=== AVERTISSEMENTS ===\n${WARNS.slice(0, 12).join('\n') || '(aucun)'}\n=== RESULTATS ===\n${json}\n\n[VERT] vérité terrain  [ROUGE] détection  [BLEU] pupille proposée`)
  POST('fin', { ok: results.length })
  document.title = 'BENCH_OK'
} catch (e) {
  log(`ECHEC: ${e && e.message}\n${results.length} scénarios mesurés`)
  POST('echec', { message: e && e.message, faits: results.length })
  document.title = 'BENCH_FAIL'
}
