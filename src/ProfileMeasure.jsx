import { useState, useRef, useCallback, useEffect } from 'react'
import { ArrowLeft, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'
import { computeContainedImageRect, screenPointToImage } from './core/imageGeometry'
import PrecisionLoupe from './components/PrecisionLoupe'
import { calculatePantoscopicAngle, isProfileMeasurementReady } from './core/profileGeometry'
import MeasureRuler from './components/MeasureRuler'

// ── Poignée de drag DÉPORTÉE (design validé par Driss) ──
// Le point de mesure exact reste SUR la mire ; la poignée (octogone translucide)
// est ÉLOIGNÉE du point pour ne jamais masquer la visée, et reliée par un segment.
const HANDLE_R = 11.52      // rayon de l'octogone → ~23 px visibles (−20 % sur 14,4)
const HANDLE_HALF = 24      // demi-épaisseur de la zone tactile du point → 48 px
const HANDLE_OFFSET = 46    // distance point → centre de la poignée (px écran)
const HANDLE_GRAB = 22      // rayon de la zone tactile de la poignée → 44 px (inchangé : confort doigt)
const HANDLE_BOX = 140      // largeur de la boîte du marqueur (le point est au centre)
const IVORY = '#f6f4ee'     // fond ivoire (translucide)
const GOLD = '#c9a05a'      // couleur « échelle » du thème (var(--color-gold))
const HANDLE_SHADOW = { filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))' }

// Style d'un bouton d'outil — calqué sur l'écran facial (PupilMarker.btnStyle).
// `color` doit être une couleur hexa : on en dérive la teinte de fond à 12 %.
const toolBtnStyle = (isActive, color) => ({
  background: isActive ? `${color}20` : 'var(--color-border)',
  color: isActive ? color : 'var(--color-text-dim)',
  border: isActive ? `1.5px solid ${color}` : '1.5px solid transparent',
})

// Octogone régulier : sommets à 22,5° + k·45° (faces à plat, notre signature)
const octagonPoints = (r) => Array.from({ length: 8 }, (_, k) => {
  const a = ((22.5 + k * 45) * Math.PI) / 180
  return `${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`
}).join(' ')
const HANDLE_OCTAGON = octagonPoints(HANDLE_R)

// ── Marqueur « lentille de contact » du point CORNÉE (vertex index 0) ──
// UN SEUL ARC (jamais deux) : il suit la courbure de la cornée, son SOMMET est
// exactement sur le point de mesure, et il bombe vers le VERRE (côté verre).
// Rendu en BANDE FINE (Driss : « comme D1, mais l'arc beaucoup plus fin »).
const LENS_SPAN_H = HANDLE_R        // demi-hauteur du marqueur (= HANDLE_R) → marqueur VERTICAL
const LENS_ARC_R  = HANDLE_R * 2.9  // rayon APPARENT de la cornée à l'échelle du marqueur.
                                    // ⚠ CHOIX DE DESSIN uniquement : ce rayon n'entre dans
                                    // AUCUN calcul de mesure (aucun facteur empirique métrologique).
const LENS_ARC_W  = 1.8             // largeur de la bande en px — « beaucoup plus fin »
// Points de l'arc, sommet en (0,0) : x = R·cos φ − R (donc x = 0 au sommet),
// y = R·sin φ → l'arc s'ouvre vers +X, c'est-à-dire vers le verre après rotation.
const LENS_ARC_PTS = (() => {
  const phi = Math.asin(Math.min(1, LENS_SPAN_H / LENS_ARC_R))
  const n = 32
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = -phi + (2 * phi * i) / n
    const x = LENS_ARC_R * Math.cos(a) - LENS_ARC_R
    const y = LENS_ARC_R * Math.sin(a)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
})()

// Distance vertex STANDARD (référence clinique des conversions de puissance).
// ⚠ Sert UNIQUEMENT à l'écartement de DÉPART des 2 poignées du vertex : elle n'entre dans
// aucun calcul de mesure — celle-ci reste (distance des 2 points × échelle réelle).
const VERTEX_START_MM = 12

// Hauteur de la LIGNE D'ŒIL sur une photo de profil. Les mires du clip latéral sont montées
// SUR la monture → elles marquent cette ligne ; l'échelle (mires) et le vertex
// (cornée → face arrière du verre) se mesurent tous deux à cette hauteur.
// ⚠ Constante PARTAGÉE par `defaultVerifyPts` et `defaultVertexPts` — une seule source.
const EYE_LINE_Y_RATIO = 0.40

// 4 chevrons fins = affordance « déplacer » (notre style, ≠ le ✥ plein d'OptiFest).
// Tracés dans un repère de référence r=18 puis mis à l'échelle → suivent toute
// modification de taille de l'octogone.
const CHEV = HANDLE_R / 18
const chev = (x1, y1, x2, y2, x3, y3) =>
  `M ${(x1 * CHEV).toFixed(2)} ${(y1 * CHEV).toFixed(2)} ` +
  `L ${(x2 * CHEV).toFixed(2)} ${(y2 * CHEV).toFixed(2)} ` +
  `L ${(x3 * CHEV).toFixed(2)} ${(y3 * CHEV).toFixed(2)}`
const HANDLE_CHEVRONS = [
  chev(-3.2, -8.6, 0, -12.2, 3.2, -8.6),
  chev(-3.2, 8.6, 0, 12.2, 3.2, 8.6),
  chev(-8.6, -3.2, -12.2, 0, -8.6, 3.2),
  chev(8.6, -3.2, 12.2, 0, 8.6, 3.2),
]

// Orientation par DÉFAUT des poignées — aucune automatique de positionnement, des
// directions fixes par famille (choix Driss) ; chaque poignée reste pivotable au
// double-tap si besoin.
//   · échelle (mires)   → à DROITE (0°)
//   · vertex            → HORIZONTAL et OPPOSÉ (point de gauche à gauche, l'autre à droite)
//   · sommet de l'angle → VERTICAL vers le haut (270°)
function defaultHandleAngle(type, i, pt, peers) {
  if (type === 'vertex') {
    if (!peers || peers.length < 2) return 0
    const ref = peers.reduce((s, p) => s + p.x, 0) / peers.length
    if (Math.abs(pt.x - ref) < 1e-6) return i % 2 === 0 ? 180 : 0
    return pt.x < ref ? 180 : 0
  }
  if (type === 'angle') return 270
  return 0
}

// Le point de mesure exact : réticule fin (croix + point), jamais masqué.
function pointReticle(color) {
  return (
    <>
      <line x1="-7.5" y1="0" x2="-3.5" y2="0" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <line x1="3.5" y1="0" x2="7.5" y2="0" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <line x1="0" y1="-7.5" x2="0" y2="-3.5" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <line x1="0" y1="3.5" x2="0" y2="7.5" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <circle r="1.7" fill={color} />
    </>
  )
}

// Poignée déportée dans N'IMPORTE QUELLE DIRECTION + segment de liaison.
// `dx`/`dy` = vecteur point → poignée (0,0 = octogone POSÉ SUR le point, sans segment).
// `angle` = orientation courante (deg), exposée en data-attribut pour la rotation.
function handleShape(color, isDragging, dx, dy, angle) {
  const onPoint = dx === 0 && dy === 0
  const len = Math.hypot(dx, dy)
  const ux = len ? dx / len : 0
  const uy = len ? dy / len : 0
  const segFrom = 9.5                        // juste après le réticule du point
  const segTo = len - HANDLE_R + 2           // jusqu'au bord de l'octogone
  return (
    <>
      {/* segment de liaison — seulement si la poignée est écartée */}
      {!onPoint && (
        <line x1={(ux * segFrom).toFixed(2)} y1={(uy * segFrom).toFixed(2)}
          x2={(ux * segTo).toFixed(2)} y2={(uy * segTo).toFixed(2)}
          stroke={color} strokeWidth="1.4" opacity="0.75" strokeLinecap="round" />
      )}
      {/* poignée : octogone translucide + chevrons (double-tap = rotation par 45°) */}
      <g transform={`translate(${dx} ${dy})`}
        {...(onPoint ? {} : { 'data-handle-rot': '1', 'data-handle-angle': String(angle) })}>
        {/* zone tactile de la poignée */}
        <circle r={HANDLE_GRAB} fill="none" pointerEvents="all" />
        <polygon points={HANDLE_OCTAGON} fill={IVORY} fillOpacity={isDragging ? 0.5 : 0.3}
          stroke={color} strokeWidth="2" strokeLinejoin="round" style={HANDLE_SHADOW} />
        {HANDLE_CHEVRONS.map((d, n) => (
          <path key={n} d={d} fill="none" stroke={color} strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round" />
        ))}
        <circle r="1.7" fill={color} />
      </g>
      {/* zone tactile du point (48 px) — le marqueur visuel est rendu séparément */}
      <rect x={-HANDLE_HALF} y={-HANDLE_HALF} width={2 * HANDLE_HALF} height={2 * HANDLE_HALF}
        fill="none" pointerEvents="all" />
    </>
  )
}

// Marqueur « cornée » — affiché AU POINT DE MESURE (vertex index 0), pas sur la poignée.
// UN SEUL ARC fin qui suit la courbure cornéenne ; son sommet est sur le point et il
// bombe vers le VERRE. `thetaDeg` oriente le marqueur sur l'axe du segment vertex
// (cornée → verre) : la cornée étant sur le plan vertical, l'arc se présente vertical.
function contactLensAtPoint(color, thetaDeg = 0) {
  return (
    <g transform={`rotate(${thetaDeg})`}>
      {/* trait principal TRÈS FIN + ombre portée (lisible sur photo claire) */}
      <polyline points={LENS_ARC_PTS} fill="none" stroke={color}
        strokeWidth={LENS_ARC_W} strokeLinecap="round" style={HANDLE_SHADOW} />
      {/* cœur clair : aspect « section de lentille » sans épaissir la bande */}
      <polyline points={LENS_ARC_PTS} fill="none" stroke={IVORY} strokeOpacity="0.5"
        strokeWidth={LENS_ARC_W * 0.5} strokeLinecap="round" />
      {/* point de mesure exact, au sommet de l'arc */}
      <circle r="1.7" fill={color} />
    </g>
  )
}

/**
 * Mesures latérales (profil D) — étape séparée après la capture de la photo.
 * Calibrage : 2 points cyan sur les mires latérales (25mm fixe) → échelle mm/px.
 * Angle pantoscopique : 2 segments reliés par un sommet dragable
 *   (🟠 extrémité branche — 🟡 SOMMET — 🔵 extrémité plan verre).
 * Vertex : segment vert cornée ↔ face arrière du verre.
 */
export default function ProfileMeasure({ imageUrl, calibrationScale, onCapture, onSkip, onBack }) {
  const [imageSize, setImageSize] = useState(null)
  const [error, setError] = useState(null)
  // Interrupteurs d'outils (Driss) : « les boutons doivent activer ET désactiver
  // les outils de mesures ». Au début des mesures latérales, SEULE l'Échelle est
  // active ; réglette, angle et vertex s'activent à la demande.
  const [toolOn, setToolOn] = useState({ scale: true, ruler: false, angle: false, vertex: false })

  // ── Calibrage 25mm (2 points sur les mires latérales) ──
  const [verifyLine, setVerifyLine] = useState([])
  const verifyResult = (() => {
    if (verifyLine.length < 2) return null
    const d = Math.hypot(verifyLine[1].x - verifyLine[0].x, verifyLine[1].y - verifyLine[0].y)
    if (d === 0) return null
    return { px: Math.round(d), impliedScale: 25 / d }
  })()
  const effectiveScale = verifyResult?.impliedScale || calibrationScale

  // ── Angle pantoscopique : 3 points (extrémité A, SOMMET, extrémité B) ──
  const [anglePts, setAnglePts] = useState([])   // [{x,y} ×3]
  // ── Vertex : cornée ↔ face arrière verre ──
  const [vertexLine, setVertexLine] = useState([])

  const dragRef = useRef(null)
  const lastDragEndRef = useRef(0)
  // Double-tap sur un octogone : { key, time } du dernier tap (rotation 45°)
  const lastTapRef = useRef({ key: null, time: 0 })
  const containerRef = useRef(null)
  const [vertexNeedsCompute, setVertexNeedsCompute] = useState(false)
  // Poignée en cours de déplacement → pastille plus opaque (repère visuel)
  const [draggingPt, setDraggingPt] = useState(null)
  // Orientation choisie par l'utilisateur, par poignée : { 'vertex-0': 135, ... }
  // Absent = sens automatique (horizontal, opposé pour les couples, bascule aux bords).
  const [handleAngles, setHandleAngles] = useState({})

  const getDisplayRect = useCallback(() => {
    if (!containerRef.current || !imageSize) return null
    return computeContainedImageRect(
      containerRef.current.clientWidth,
      containerRef.current.clientHeight,
      imageSize.width,
      imageSize.height,
    )
  }, [imageSize])

  // ── Dispositions par défaut des poignées créées par les boutons d'outil ──
  // (Driss : « en appuyant sur le bouton tu actives toutes les poignées au lieu
  // d'une par une »). Elles apparaissent groupées puis se déplacent au doigt.
  const defaultAnglePts = useCallback(() => {
    if (!imageSize) return []
    const { width: w, height: h } = imageSize
    return [
      { x: Math.round(w * 0.62), y: Math.round(h * 0.42) },  // 🟠 extrémité sur la branche
      { x: Math.round(w * 0.50), y: Math.round(h * 0.42) },  // 🟣 sommet (charnière)
      { x: Math.round(w * 0.50), y: Math.round(h * 0.55) },  // 🔵 extrémité sur le plan du verre
    ]
  }, [imageSize])

  // ── Écartement de DÉPART des 2 poignées du vertex ──
  // Ce n'est PAS une mesure : l'utilisateur pose ensuite les 2 points sur la cornée puis
  // sur la face arrière du verre. Ancien défaut : `w/2 ± 30` en pixels IMAGE → sur une
  // photo de 4032 px les 2 repères n'étaient écartés que d'une douzaine de px à l'écran,
  // donc CONFONDUS (on ne distinguait pas les 2 points).
  //   • échelle connue  → distance vertex STANDARD (12 mm) convertie par l'échelle RÉELLE :
  //     la valeur affichée au départ est donc plausible, et les 2 repères sont distincts ;
  //   • échelle inconnue → repli proportionnel : 14 % de la largeur, la convention des
  //     2 poignées de l'échelle (0,43 / 0,57).
  const vertexStartHalfPx = useCallback(() => {
    if (!imageSize) return 0
    const half = effectiveScale && effectiveScale > 0
      ? VERTEX_START_MM / effectiveScale / 2
      : imageSize.width * 0.07
    // borne : les 2 points restent dans le cadre
    return Math.round(Math.min(half, imageSize.width * 0.40))
  }, [imageSize, effectiveScale])

  const defaultVertexPts = useCallback(() => {
    if (!imageSize) return []
    const w = imageSize.width, h = imageSize.height
    const half = vertexStartHalfPx()
    // Même hauteur que les mires de l'échelle : le vertex se mesure à la ligne d'œil.
    const y = Math.round(h * EYE_LINE_Y_RATIO)
    return [
      { x: Math.round(w / 2 - half), y },
      { x: Math.round(w / 2 + half), y },
    ]
  }, [imageSize, vertexStartHalfPx])

  // Les 2 poignées de l'échelle (les marqueurs du clip) : c'est leur écartement
  // qui donne les px/mm. Positions de départ à ajuster sur les 2 cercles noirs.
  const defaultVerifyPts = useCallback(() => {
    if (!imageSize) return []
    const { width: w, height: h } = imageSize
    const y = Math.round(h * EYE_LINE_Y_RATIO)
    return [
      { x: Math.round(w * 0.43), y },
      { x: Math.round(w * 0.57), y },
    ]
  }, [imageSize])

  const toImageCoords = useCallback((clientX, clientY) => {
    if (!containerRef.current || !imageSize) return null
    return screenPointToImage(
      clientX,
      clientY,
      containerRef.current.getBoundingClientRect(),
      getDisplayRect(),
      imageSize,
    )
  }, [getDisplayRect, imageSize])

  // ── Chargement de l'image ──
  useEffect(() => {
    const img = new Image()
    img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => setError('Image de profil illisible')
    img.src = imageUrl
  }, [imageUrl])

  const allAngleDone = anglePts.length >= 3

  // ── L'échelle est active dès l'arrivée : on crée donc ses 2 poignées tout de
  // suite (Driss : « en appuyant sur le bouton échelle tu devrais activer les 2
  // poignées »). Elles sont prêtes à être posées sur les 2 cercles noirs.
  useEffect(() => {
    if (toolOn.scale && verifyLine.length === 0 && imageSize) {
      setVerifyLine(defaultVerifyPts())
    }
  }, [toolOn.scale, verifyLine.length, imageSize, defaultVerifyPts])

  // ── Vertex auto-placé quand l'angle est fait ──
  useEffect(() => {
    if (allAngleDone && vertexLine.length === 0 && imageSize) {
      setVertexLine(defaultVertexPts())
      setVertexNeedsCompute(true)
    }
  }, [allAngleDone, vertexLine.length, imageSize, defaultVertexPts])

  // ── Vertex → API backend (distance pure, sans correction) ──
  const [vertexMm, setVertexMm] = useState(null)
  const [vertexLoading, setVertexLoading] = useState(false)
  const [vertexError, setVertexError] = useState(null)
  const [vertexAdjusted, setVertexAdjusted] = useState(false)
  const vertexRequestRef = useRef(0)

  const computeVertexFromAPI = useCallback(async () => {
    if (vertexLine.length < 2 || !effectiveScale) return
    const requestId = ++vertexRequestRef.current
    setVertexLoading(true)
    setVertexError(null)
    setVertexMm(null)
    try {
      const res = await fetch('/api/compute-vertex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cornea_x: vertexLine[0].x, cornea_y: vertexLine[0].y,
          lens_back_x: vertexLine[1].x, lens_back_y: vertexLine[1].y,
          scale_mm_per_px: effectiveScale,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || `Erreur vertex HTTP ${res.status}`)
      if (requestId === vertexRequestRef.current) setVertexMm(data.vertex_distance_mm)
    } catch (error) {
      if (requestId === vertexRequestRef.current) setVertexError(error.message || 'Calcul vertex impossible')
    } finally {
      if (requestId === vertexRequestRef.current) setVertexLoading(false)
    }
  }, [vertexLine, effectiveScale])

  useEffect(() => {
    if (vertexLine.length === 2 && vertexNeedsCompute) {
      setVertexNeedsCompute(false)
      computeVertexFromAPI()
    }
  }, [vertexLine, vertexNeedsCompute, computeVertexFromAPI])

  // ── Loupe de précision pendant le glissement d'une poignée ──
  // Elle se centre sur LE POINT MESURÉ, jamais sur le doigt : pour le sommet de l'angle,
  // l'octogone est DÉPORTÉ (HANDLE_OFFSET) — le doigt tient l'octogone et le point est
  // ailleurs. Centrer sur le doigt montrerait à côté de la mesure.
  const ANGLE_COLORS = ['#f59e0b', '#a78bfa', '#3b9eff']   // branche · sommet · plan du verre
  const ANGLE_LABELS = ['Branche', 'Sommet', 'Plan verre']   // courts : la bulle les tronque sinon
  const loupeSrc = draggingPt
    ? ({ verify: verifyLine, angle: anglePts, vertex: vertexLine }[draggingPt.type] || [])[draggingPt.i]
    : null
  const loupeColor = draggingPt
    ? (draggingPt.type === 'angle'
      ? ANGLE_COLORS[draggingPt.i]
      : draggingPt.type === 'verify' ? '#22d3ee' : '#10b981')
    : null
  const loupeLabel = draggingPt
    ? (draggingPt.type === 'angle' ? ANGLE_LABELS[draggingPt.i]
      : draggingPt.type === 'verify' ? 'Échelle' : 'Vertex')
    : null

  const allDone = isProfileMeasurementReady(anglePts, vertexLine, vertexMm, vertexLoading, vertexAdjusted)

  // ── Drag & drop des poignées (data-pt-type + data-pt-index) ──
  const handlePointerDown = useCallback((e) => {
    const ep = e.target.closest('[data-pt-type]')
    if (!ep || !imageSize) return
    e.preventDefault()
    e.stopPropagation()
    const ptType = ep.dataset.ptType
    const index = parseInt(ep.dataset.ptIndex)
    // Rotation : un double-tap sur l'octogone le fait pivoter de 45°, poignée par poignée
    const rotEl = e.target.closest('[data-handle-rot]')
    const rotKey = rotEl ? `${ptType}-${index}` : null
    const rotFrom = rotEl ? Number(rotEl.dataset.handleAngle || 0) : 0
    let moved = false
    const setter = { verify: setVerifyLine, angle: setAnglePts, vertex: setVertexLine }[ptType]
    if (!setter) return
    if (ptType === 'vertex') {
      vertexRequestRef.current += 1
      setVertexLoading(false)
      setVertexMm(null)
      setVertexError(null)
      setVertexAdjusted(false)
    }
    const startImg = toImageCoords(e.clientX, e.clientY)
    if (!startImg) return

    setDraggingPt({ type: ptType, i: index })
    setter(prev => {
      const orig = prev[index]; if (!orig) return prev
      dragRef.current = { setter, index, startImg, oX: orig.x, oY: orig.y }
      return prev
    })
    const onMove = (ev) => {
      const d = dragRef.current; if (!d) return
      const currentImg = toImageCoords(ev.clientX, ev.clientY)
      if (!currentImg) return
      const dx = currentImg.x - d.startImg.x
      const dy = currentImg.y - d.startImg.y
      // Seuil de 3 px (image) : au-delà on considère que c'est un vrai drag
      if (Math.hypot(dx, dy) > 3) { d.moved = true; moved = true }
      const nx = Math.round(Math.max(0, Math.min(imageSize.width, d.oX + dx)))
      const ny = Math.round(Math.max(0, Math.min(imageSize.height, d.oY + dy)))
      d.setter(prev => { const n = [...prev]; n[d.index] = { x: nx, y: ny }; return n })
    }
    const onUp = () => {
      const wasVertex = dragRef.current?.setter === setVertexLine
      // Si un vrai déplacement a eu lieu, marquer l'instant pour neutraliser le clic suivant
      if (moved) lastDragEndRef.current = Date.now()
      // Double-tap sur l'octogone sans déplacement → rotation de 45° (par poignée)
      if (rotKey && !moved) {
        const now = Date.now()
        const prev = lastTapRef.current
        if (prev.key === rotKey && now - prev.time < 400) {
          lastTapRef.current = { key: null, time: 0 }
          setHandleAngles(a => ({ ...a, [rotKey]: (rotFrom + 45) % 360 }))
        } else {
          lastTapRef.current = { key: rotKey, time: now }
        }
      }
      dragRef.current = null
      setDraggingPt(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (wasVertex) {
        setVertexAdjusted(true)
        setVertexNeedsCompute(true)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [imageSize, toImageCoords])

  // ── Barre d'outils : chaque bouton ACTIVE / DÉSACTIVE son outil de mesure ──
  // Activer l'angle ou le vertex crée ses poignées d'un coup si elles n'existent
  // pas encore (Driss) ; les mesures déjà calculées sont conservées quand on
  // masque un outil, seul l'affichage change.
  const toggleTool = useCallback((tool) => {
    const turningOn = !toolOn[tool]
    setToolOn(prev => ({ ...prev, [tool]: !prev[tool] }))
    if (!turningOn) return
    // À l'activation, chaque outil crée TOUTES ses poignées d'un coup (Driss)
    if (tool === 'scale' && verifyLine.length === 0) setVerifyLine(defaultVerifyPts())
    if (tool === 'angle' && anglePts.length === 0) setAnglePts(defaultAnglePts())
    if (tool === 'vertex' && vertexLine.length === 0) {
      setVertexLine(defaultVertexPts())
      setVertexNeedsCompute(true)
    }
  }, [toolOn, verifyLine.length, anglePts.length, vertexLine.length, defaultVerifyPts, defaultAnglePts, defaultVertexPts])

  // ── Clic sur l'image : pose un point pour le 1er outil ACTIF encore incomplet ──
  const handleImageClick = useCallback((e) => {
    if (!imageSize) return
    // Un drag vient de se terminer (< 300 ms) : le relâchement ne doit pas ajouter un point
    if (Date.now() - lastDragEndRef.current < 300) return
    if (e.target.closest('[data-pt-type]')) return
    const mapped = toImageCoords(e.clientX, e.clientY)
    if (!mapped) return
    const pt = { x: Math.round(mapped.x), y: Math.round(mapped.y) }
    if (toolOn.scale && verifyLine.length < 2) {
      setVerifyLine(prev => [...prev, pt])
      return
    }
    if (toolOn.angle && anglePts.length < 3) {
      setAnglePts(prev => [...prev, pt])
      return
    }
    if (toolOn.vertex && vertexLine.length < 2) {
      setVertexLine(prev => [...prev, pt])
      setVertexAdjusted(true)
      setVertexNeedsCompute(true)
    }
  }, [imageSize, toolOn, verifyLine.length, anglePts.length, vertexLine.length, toImageCoords])

  // ── Angle pantoscopique : écart à 90° de l'angle entre les 2 segments ──
  // Le plan du verre est perpendiculaire à la branche → angle brut ≈ 90°.
  // La pantoscopie est la DÉVIATION par rapport à cette perpendiculaire.
  const pantoscopic = calculatePantoscopicAngle(anglePts)

  // ── Reset ──
  const resetMeasure = useCallback(() => {
    vertexRequestRef.current += 1
    setVertexLoading(false)
    setVerifyLine([]); setAnglePts([]); setVertexLine([]); setHandleAngles({}); setVertexMm(null); setVertexError(null); setVertexAdjusted(false)
    setToolOn({ scale: true, ruler: false, angle: false, vertex: false })
  }, [])

  // ── Validation ──
  const confirm = useCallback(() => {
    onCapture({
      width: imageSize?.width || 0, height: imageSize?.height || 0,
      lateral_markers: verifyLine.length === 2 ? [[verifyLine[0].x, verifyLine[0].y], [verifyLine[1].x, verifyLine[1].y]] : null,
      temple_markers: anglePts.length === 3 ? [[anglePts[0].x, anglePts[0].y], [anglePts[1].x, anglePts[1].y]] : null,
      vertex_markers: vertexLine.length === 2 ? [[vertexLine[0].x, vertexLine[0].y], [vertexLine[1].x, vertexLine[1].y]] : null,
      pantoscopic_angle: pantoscopic || 0,
      vertex_distance: vertexMm,
      manual: true, face_detected: false,
      scale_mm_per_px: effectiveScale || 0,
    })
  }, [imageSize, verifyLine, anglePts, vertexLine, pantoscopic, vertexMm, effectiveScale, onCapture])

  // ── Rendu SVG ──
  const toPct = (v, d) => `${(v / d) * 100}%`

  const renderLines = () => {
    if (!imageSize) return null
    return (
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 10 }}>
        {/* Ligne de calibrage cyan — fine, tirets longs (outil « échelle ») */}
        {toolOn.scale && verifyLine.length >= 2 && (
          <line x1={toPct(verifyLine[0].x, imageSize.width)} y1={toPct(verifyLine[0].y, imageSize.height)}
            x2={toPct(verifyLine[1].x, imageSize.width)} y2={toPct(verifyLine[1].y, imageSize.height)}
            stroke="#22d3ee" strokeWidth="1.4" strokeLinecap="round" opacity="0.75" strokeDasharray="6 4" />
        )}
        {/* Angle : 2 segments fins reliés au sommet */}
        {toolOn.angle && anglePts.length >= 2 && (
          <>
            <line x1={toPct(anglePts[0].x, imageSize.width)} y1={toPct(anglePts[0].y, imageSize.height)}
              x2={toPct(anglePts[1].x, imageSize.width)} y2={toPct(anglePts[1].y, imageSize.height)}
              stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" opacity="0.85" />
            {anglePts.length >= 3 && (
              <line x1={toPct(anglePts[1].x, imageSize.width)} y1={toPct(anglePts[1].y, imageSize.height)}
                x2={toPct(anglePts[2].x, imageSize.width)} y2={toPct(anglePts[2].y, imageSize.height)}
                stroke="#3b9eff" strokeWidth="1.8" strokeLinecap="round" opacity="0.85" />
            )}
          </>
        )}
        {/* Arc d'angle + valeur */}
        {toolOn.angle && pantoscopic !== null && (() => {
          const [a, v, b] = anglePts
          const r = 34
          const a1 = Math.atan2(a.y - v.y, a.x - v.x)
          const a2 = Math.atan2(b.y - v.y, b.x - v.x)
          // Arc du premier vers le second angle (sens court)
          let delta = a2 - a1
          while (delta > Math.PI) delta -= 2 * Math.PI
          while (delta < -Math.PI) delta += 2 * Math.PI
          const steps = 24
          const arcPts = []
          for (let i = 0; i <= steps; i++) {
            const t = a1 + (delta * i) / steps
            arcPts.push(`${v.x + r * Math.cos(t)},${v.y + r * Math.sin(t)}`)
          }
          const labelA = a1 + delta * 0.5
          return (
            <>
              <polyline points={arcPts.map(p => `${toPct(parseFloat(p.split(',')[0]), imageSize.width)},${toPct(parseFloat(p.split(',')[1]), imageSize.height)}`).join(' ')}
                fill="none" stroke="#a78bfa" strokeWidth="1.5" opacity="0.8" />
              <text x={toPct(v.x + (r + 16) * Math.cos(labelA), imageSize.width)}
                y={toPct(v.y + (r + 16) * Math.sin(labelA), imageSize.height)}
                fontSize="12" fill="#a78bfa" fontWeight="700" textAnchor="middle" dominantBaseline="middle"
                style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.8))' }}>{pantoscopic}°</text>
            </>
          )
        })()}
        {/* Segment vertex */}
        {toolOn.vertex && vertexLine.length >= 2 && (
          <line x1={toPct(vertexLine[0].x, imageSize.width)} y1={toPct(vertexLine[0].y, imageSize.height)}
            x2={toPct(vertexLine[1].x, imageSize.width)} y2={toPct(vertexLine[1].y, imageSize.height)}
            stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" opacity="0.8" strokeDasharray="6 3" />
        )}
      </svg>
    )
  }

  // ── Poignées de drag : octogone (notre signature) ──
  // Le point de mesure exact est matérialisé par un réticule fin, TOUJOURS visible.
  const renderEndpoints = () => {
    if (!imageSize) return null
    // Groupes de points d'un même couple (sert au sens d'écartement opposé).
    // Les groupes restent complets même masqués : seule la VISIBILITÉ suit les boutons.
    const groups = { verify: verifyLine, angle: anglePts, vertex: vertexLine }
    const items = []
    if (toolOn.scale) verifyLine.forEach((pt, i) => items.push({ pt, color: '#22d3ee', type: 'verify', i }))
    if (toolOn.angle) anglePts.forEach((pt, i) => items.push({
      pt,
      color: i === 1 ? '#a78bfa' : i === 0 ? '#f59e0b' : '#3b9eff',
      type: 'angle', i,
    }))
    if (toolOn.vertex) vertexLine.forEach((pt, i) => items.push({ pt, color: '#10b981', type: 'vertex', i }))

    const lastPlaced = (() => {
      if (toolOn.scale && verifyLine.length === 1) return { type: 'verify', i: 0 }
      if (toolOn.angle && anglePts.length > 0 && anglePts.length < 3) {
        return { type: 'angle', i: anglePts.length - 1 }
      }
      return null
    })()

    // Angle de l'axe CORNÉE → VERRE : oriente le marqueur « lentille » du point cornée.
    // La cornée étant sur le plan vertical, l'arc se présente vertical quand cet axe
    // est horizontal — et il suit toujours la photo si le profil est incliné.
    const corneaTheta = (() => {
      if (vertexLine.length < 2) return 0
      const [c, v] = vertexLine
      return Math.round((Math.atan2(v.y - c.y, v.x - c.x) * 180) / Math.PI * 10) / 10
    })()

    return items.map(({ pt, color, type, i }, k) => {
      const isLast = lastPlaced && lastPlaced.type === type && lastPlaced.i === i
      const isDragging = !!draggingPt && draggingPt.type === type && draggingPt.i === i
      // Angle pantoscopique : les 2 extrémités (branche 🟠 et plan du verre 🔵) ont
      // l'octogone POSÉ SUR le point — ni écartement, ni segment. Le sommet 🟣 est
      // écarté verticalement. Directions par défaut fixes (cf. defaultHandleAngle),
      // aucune automatique ; chaque poignée reste pivotable (double-tap → 45°).
      const onPoint = type === 'angle' && i !== 1
      const key = `${type}-${i}`
      const deg = handleAngles[key] ?? defaultHandleAngle(type, i, pt, groups[type])
      const rad = (deg * Math.PI) / 180
      const r2 = (v) => { const n = Math.round(v * 100) / 100; return n === 0 ? 0 : n }
      const dx = onPoint ? 0 : r2(HANDLE_OFFSET * Math.cos(rad))
      const dy = onPoint ? 0 : r2(HANDLE_OFFSET * Math.sin(rad))
      // Vertex index 0 = cornée → lentille DE CONTACT AU POINT (marqueur visuel)
// + poignée octogone déportée pour le drag (identique à index 1)
      const isCornea = type === 'vertex' && i === 0
      return (
        <div key={`${type}${k}`} data-pt-type={type} data-pt-index={i} style={{
          position: 'absolute', left: toPct(pt.x, imageSize.width), top: toPct(pt.y, imageSize.height),
          transform: 'translate(-50%,-50%)',
          width: HANDLE_BOX, height: HANDLE_BOX,
          // Le conteneur est transparent aux events : seuls la poignée et le point sont saisissables
          pointerEvents: 'none', touchAction: 'none',
          cursor: isDragging ? 'grabbing' : 'grab', zIndex: 15,
          WebkitTouchCallout: 'none', WebkitUserSelect: 'none',
        }}>
          <svg width={HANDLE_BOX} height={HANDLE_BOX}
            viewBox={`-${HANDLE_BOX / 2} -${HANDLE_BOX / 2} ${HANDLE_BOX} ${HANDLE_BOX}`}>
            {/* Halo pulsant — dernier point placé, centré sur le POINT (guidage) */}
            {isLast && (
              <circle r="13" fill="none" stroke={color} strokeWidth="1" opacity="0.5"
                style={{ animation: 'reticle-pulse 1.6s ease-out infinite' }} />
            )}
            {/* Marqueur visuel AU POINT : lentille de contact pour la cornée, réticule pour les autres */}
            {isCornea ? contactLensAtPoint(color, corneaTheta) : pointReticle(color)}
            {/* Poignée de drag (toujours octogone) — déportée si angle != 0° sur le point */}
            {handleShape(color, isDragging, dx, dy, deg)}
          </svg>
        </div>
      )
    })
  }

  // ════════════════════════════════════
  // RENDU
  // ════════════════════════════════════

  if (error) {
    return (
      <div className="space-y-4 animate-fade-in">
        <div className="rounded-2xl p-8 border text-center" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
          <AlertTriangle size={32} style={{ color: 'var(--color-red)', margin: '0 auto 12px' }} />
          <p className="text-sm mb-4" style={{ color: 'var(--color-text-muted)' }}>{error}</p>
          <button onClick={onBack} className="px-6 py-2.5 rounded-full font-medium text-sm"
            style={{ background: 'var(--color-gold)', color: 'var(--color-bg)' }}>Retour</button>
        </div>
      </div>
    )
  }

  if (!imageSize) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin" style={{ color: 'var(--color-purple)' }} />
        <span className="text-sm ml-3" style={{ color: 'var(--color-text-muted)' }}>Chargement...</span>
      </div>
    )
  }

  // Aide contextuelle : le message suit l'outil le plus « avancé » qui est actif
  const hint = (() => {
    if (toolOn.angle) {
      return {
        text: <>∠ <strong>{pantoscopic !== null ? `${pantoscopic}°` : '—'}</strong> — ajustez les 3 poignées : 🟠 branche, 🟣 sommet (charnière), 🔵 plan du verre</>,
        color: '#a78bfa', bg: 'rgba(167,139,250,0.08)', border: 'rgba(167,139,250,0.25)',
      }
    }
    if (toolOn.vertex) {
      return {
        text: <>↔ <strong>{vertexLoading ? '…' : vertexMm ? `${vertexMm} mm` : '—'}</strong> — ajustez les 2 poignées : cornée et plan arrière du verre</>,
        color: 'var(--color-green)', bg: 'var(--color-green-bg)', border: 'rgba(16,185,129,0.25)',
      }
    }
    if (toolOn.scale) {
      return {
        text: verifyLine.length === 2
          ? <>🔷 Échelle <strong>{effectiveScale ? `${(1 / effectiveScale).toFixed(2)} px/mm` : '—'}</strong> — posez les 2 poignées sur les <strong>2 cercles noirs</strong></>
          : <>🔷 Placez les 2 poignées sur les <strong>2 cercles noirs</strong> ({verifyLine.length}/2)</>,
        color: GOLD, bg: 'var(--color-gold-bg)', border: 'rgba(201,160,90,0.3)',
      }
    }
    if (toolOn.ruler) {
      return {
        text: <>📐 Réglette affichée — elle n'est juste qu'une fois le calibrage fait.</>,
        color: '#22d3ee', bg: 'rgba(34,211,238,0.08)', border: 'rgba(34,211,238,0.3)',
      }
    }
    return {
      text: <>Tous les outils sont masqués — appuyez sur un bouton pour en activer un.</>,
      color: 'var(--color-text-muted)', bg: 'var(--color-card)', border: 'var(--color-border)',
    }
  })()
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-1 h-8 rounded-full" style={{ background: 'linear-gradient(var(--color-purple), var(--color-purple-light))' }} />
        <div>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text)', fontFamily: "'Playfair Display', Georgia, serif" }}>
            Mesures latérales
          </h2>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Angle pantoscopique & distance vertex</p>
        </div>
      </div>

      {/* Barre d'outils — 4 interrupteurs (Driss) : chaque bouton ACTIVE et
          DÉSACTIVE son outil de mesure. Les valeurs restent affichées même
          quand l'outil est masqué. */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        <button type="button" onClick={() => toggleTool('scale')}
          className="flex-1 min-w-[132px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1.5"
          style={toolBtnStyle(toolOn.scale, GOLD)}>
          📏 Échelle · {effectiveScale ? `${(1 / effectiveScale).toFixed(2)} px/mm` : '—'}
        </button>

        <button type="button" onClick={() => toggleTool('ruler')}
          className="flex-1 min-w-[100px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1.5"
          style={toolBtnStyle(toolOn.ruler, '#22d3ee')}>
          📐 Réglette
        </button>

        <button type="button" onClick={() => toggleTool('vertex')}
          className="flex-1 min-w-[138px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1.5"
          style={toolBtnStyle(toolOn.vertex, '#10b981')}>
          ↔ Vertex · {vertexMm ? `${vertexMm} mm` : vertexLoading ? '…' : '—'}
        </button>

        <button type="button" onClick={() => toggleTool('angle')}
          className="flex-1 min-w-[152px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1.5"
          style={toolBtnStyle(toolOn.angle, '#a78bfa')}>
          ∠ Angle pantoscopique · {pantoscopic !== null ? `${pantoscopic}°` : '—'}
        </button>
      </div>

      <div className="rounded-2xl border overflow-hidden relative" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
        <div ref={containerRef} className="relative select-none aspect-[3/4]" style={{ touchAction: 'none' }}
          onPointerDown={handlePointerDown} onClick={handleImageClick}>
          <img src={imageUrl} alt="Profil" className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
          {getDisplayRect() && (() => {
            const dr = getDisplayRect()
            return (
              <div className="absolute" style={{ left: dr.left, top: dr.top, width: dr.width, height: dr.height }}>
                {renderLines()}
                {renderEndpoints()}
                {/* Loupe partagée — la même que sur les repères et le calibrage. Elle est
                    centrée sur LE POINT MESURÉ (loupeSrc), pas sur la poignée : au sommet
                    de l'angle l'octogone est déporté et le doigt n'est pas sur la mesure. */}
                {loupeSrc && (
                  <PrecisionLoupe dr={dr} imageSize={imageSize} imageUrl={imageUrl} pos={loupeSrc}
                    color={loupeColor} label={loupeLabel}
                    mmPerPx={effectiveScale || null}
                    spanMm={8}
                    reticle={
                      <svg width={22} height={22} viewBox="-11 -11 22 22">{pointReticle(loupeColor)}</svg>
                    }
                    reticleSize={22} />
                )}
                <MeasureRuler variant="ruler" scaleMmPerPx={effectiveScale} imageSize={imageSize} displayRect={dr} visible={toolOn.ruler} onToggle={() => toggleTool('ruler')} />
              </div>
            )
          })()}
        </div>
      </div>

      <div className="rounded-xl px-4 py-3 text-xs" style={{
        background: hint.bg, color: hint.color,
        borderWidth: 1, borderStyle: 'solid', borderColor: hint.border,
      }}>
        {hint.text}
        <div className="mt-1.5 opacity-75">
          ↻ Double-tap sur un octogone pour le faire pivoter par pas de 45°
          {Object.keys(handleAngles).length > 0
            && ` · ${Object.keys(handleAngles).length} pivotée${Object.keys(handleAngles).length > 1 ? 's' : ''} à la main`}
        </div>
      </div>

      {vertexError && (
        <div className="rounded-xl px-3 py-2 text-xs flex items-center justify-between gap-3"
          style={{ background: 'var(--color-red-bg)', color: 'var(--color-red)', border: '1px solid rgba(255,107,107,0.25)' }}>
          <span>{vertexError}</span>
          <button onClick={computeVertexFromAPI} className="px-3 py-1.5 rounded-lg font-medium shrink-0"
            style={{ background: 'var(--color-red)', color: '#fff' }}>Réessayer</button>
        </div>
      )}

      {allAngleDone && !allDone && !vertexError && (
        <div className="text-center text-xs" style={{ color: 'var(--color-gold)' }}>
          {vertexLoading ? 'Calcul de la distance vertex…' : vertexAdjusted ? 'Calcul vertex en attente.' : 'Placez précisément les deux points sur la cornée et le vrai plan arrière du verre.'}
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={onBack} className="flex items-center justify-center gap-1.5 flex-1 py-2.5 rounded-full text-sm font-medium"
          style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
          <ArrowLeft size={14} /> Retour
        </button>
        <button onClick={resetMeasure} className="flex-1 py-2.5 rounded-full text-sm font-medium"
          style={{ background: 'var(--color-border)', color: verifyLine.length > 0 ? 'var(--color-text-muted)' : 'var(--color-text-dim)', opacity: verifyLine.length > 0 ? 1 : 0.5 }}
          disabled={verifyLine.length === 0}>Refaire</button>
        {allDone && (
          <button onClick={confirm} className="flex-1 py-2.5 rounded-full text-sm font-medium text-white"
            style={{ background: 'var(--color-gold)' }}>
            <CheckCircle2 size={14} className="inline mr-1" /> Valider
          </button>
        )}
      </div>

      <button onClick={onSkip} className="w-full py-2 rounded-full text-xs"
        style={{ background: 'transparent', color: 'var(--color-text-dim)' }}>Passer cette étape</button>
    </div>
  )
}
