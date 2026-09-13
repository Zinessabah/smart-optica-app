import { detectFace } from '../src/core/faceDetection.js'

const POST = (stage, data) => fetch('http://127.0.0.1:5199/r', {
  method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ stage, data }) }).catch(() => {})

const PHOTOS = [
  'backend/uploads/7aab27b7-42e2-4bb5-8fe5-86c274f2777c/06f17b35-0147-4986-9e78-5637421f4b45_face.png',
  'backend/uploads/7aab27b7-42e2-4bb5-8fe5-86c274f2777c/171fc69c-a1b1-4cbf-bd52-cd409c262084_face.png',
  'backend/uploads/7aab27b7-42e2-4bb5-8fe5-86c274f2777c/b9b1a569-c627-4671-8cea-34abb0ce6025_face.png',
  'backend/uploads/7aab27b7-42e2-4bb5-8fe5-86c274f2777c/cbbd7db9-380a-4830-a8d8-4f8271431f28_face.png',
  'backend/uploads/7aab27b7-42e2-4bb5-8fe5-86c274f2777c/e6a291ff-aa9e-46e2-a48d-97195df1619f_face.png',
  'backend/uploads/7aab27b7-42e2-4bb5-8fe5-86c274f2777c/fc6428b1-d23d-4291-a243-834eb9694a58_face.png'
]

const load = (url) => new Promise((res, rej) => {
  const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('chargement impossible')); i.src = url
})

for (const p of PHOTOS) {
  const nom = p.split('/').pop().slice(0, 8)
  try {
    const img = await load('/' + p)
    const size = { width: img.naturalWidth, height: img.naturalHeight }
    const t0 = performance.now()
    const det = await detectFace(img, size)
    const ms = Math.round(performance.now() - t0)

    let scores = {}
    try {
      const fa = await import('face-api.js')
      for (const s of [416, 608]) {
        const d = await fa.detectSingleFace(img, new fa.TinyFaceDetectorOptions({ inputSize: s }))
        scores['s' + s] = d ? +d.score.toFixed(3) : null
      }
    } catch (e) { scores = { erreur: String(e.message) } }

    const sc = 460 / size.width
    const v = document.createElement('canvas')
    v.width = Math.round(size.width * sc); v.height = Math.round(size.height * sc)
    const vg = v.getContext('2d')
    vg.drawImage(img, 0, 0, v.width, v.height)
    const cross = (pt, col, r) => { if (!pt) return
      vg.strokeStyle = col; vg.lineWidth = 2
      vg.beginPath(); vg.arc(pt.x * sc, pt.y * sc, r, 0, 7); vg.stroke()
      vg.beginPath(); vg.moveTo(pt.x * sc - r * 1.7, pt.y * sc); vg.lineTo(pt.x * sc + r * 1.7, pt.y * sc)
      vg.moveTo(pt.x * sc, pt.y * sc - r * 1.7); vg.lineTo(pt.x * sc, pt.y * sc + r * 1.7); vg.stroke() }
    cross(det.leftEye, '#ff2d2d', 6); cross(det.rightEye, '#ff2d2d', 6); cross(det.nose, '#2d7dff', 6)
    vg.fillStyle = '#000'; vg.fillRect(0, 0, v.width, 18)
    vg.fillStyle = '#0f0'; vg.font = '13px monospace'
    vg.fillText(nom + ' — ' + det.method + ' — ' + size.width + 'x' + size.height, 5, 13)

    POST('reelle', {
      nom, fichier: p, taille: size.width + 'x' + size.height, methode: det.method, ms, scores,
      detecte: { od: det.leftEye, og: det.rightEye, nez: det.nose },
      vignette: v.toDataURL('image/jpeg', 0.72),
    })
  } catch (e) {
    POST('reelle_erreur', { nom, fichier: p, message: String(e.message) })
  }
}
POST('reelle_fin', { total: PHOTOS.length })
