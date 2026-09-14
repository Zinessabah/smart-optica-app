import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronLeft, RotateCcw, ZoomIn, Camera, Check, Loader2, AlertTriangle } from 'lucide-react'
import BoxingRect from './BoxingRect'
import PrecisionLoupe from './components/PrecisionLoupe'
import MeasureRuler from './components/MeasureRuler'
import { detectFace } from './core/faceDetection'
import { calculateMonocularPD, calculatePont, calculateBoxingDimensions, getDefaultBoxSize as coreDefaultBoxSize, mirrorBox, resolveLensDiameter, DEFAULT_LENS_DIAMETER_MM, isFrontMeasurementReady } from './core/optics'
// Contrôles objectifs (netteté relative, inclinaison, alignement) — à ne pas
// confondre avec core/photoQuality.ts qui note la PRISE DE VUE (flou/exposition).
import { eyeRegions, evaluatePhotoQuality, gridSharpness, blockSharpness } from './core/photoChecks'

// Affichage des verdicts de contrôle (aucune correction : uniquement des constats)
const QUALITY_ICON = { ok: '✓', warn: '⚠️', bad: '✕' }
const QUALITY_COLOR = { ok: 'var(--color-green)', warn: 'var(--color-gold)', bad: 'var(--color-red)' }

export default function PupilMarker({ imageUrl, calibration, onConfirm, onBack, onRetake, initialLeftEye, initialRightEye, initialBridge }) {
  const [imageSize, setImageSize] = useState(null)
  const [leftEye, setLeftEye] = useState(null)
  const [rightEye, setRightEye] = useState(null)
  const [bridge, setBridge] = useState(null) // Un seul repère central de pont (haut du nez)
  const [boxOG, setBoxOG] = useState(null)
  const [boxOD, setBoxOD] = useState(null)
  const [lensRadiusOG, setLensRadiusOG] = useState(null) // rayon ébauche choisi (px image) — null = rMin
  const [lensRadiusOD, setLensRadiusOD] = useState(null)
  // Centre du cercle Ø verre, gelé à l'activation/drag (null = suit la pupille)
  const [lensCenterOG, setLensCenterOG] = useState(null) // {x,y} pupille au moment du gel
  const [lensCenterOD, setLensCenterOD] = useState(null)
  const [lensActive, setLensActive] = useState(false) // toggle affichage/édition du Ø verre à commander
  const [activeMarker, setActiveMarker] = useState('bridge')
  const [faceDetectStatus, setFaceDetectStatus] = useState('idle') // idle | detecting | success | failed
    const [panelPos, setPanelPos] = useState(null) // null = use default
  const panelDragRef = useRef(null) // { startX, startY, baseX, baseY }
  const panelRef = useRef(null)
  const containerRef = useRef(null)
  const cancelAutoFaceRef = useRef(false)
  const [rulerVisible, setRulerVisible] = useState(false)
  // Analyse de netteté de la photo (une seule fois par image) — contrôle objectif
  const [imageGray, setImageGray] = useState(null)

  // L'image est échantillonnée hors écran : niveaux de gris + netteté du bloc le
  // plus net (référence interne). Si le canvas est illisible (origine non sûre),
  // on renvoie null : le contrôle se déclare « indisponible », jamais « ok ».
  useEffect(() => {
    if (!imageUrl || !imageSize) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      try {
        const s = Math.min(1, 700 / Math.max(1, img.naturalWidth))
        const w = Math.max(1, Math.round(img.naturalWidth * s))
        const h = Math.max(1, Math.round(img.naturalHeight * s))
        const cv = document.createElement('canvas')
        cv.width = w; cv.height = h
        const ctx = cv.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0, w, h)
        const data = ctx.getImageData(0, 0, w, h).data
        const gray = new Float64Array(w * h)
        for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
          gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
        }
        const best = gridSharpness(gray, w, h)
        if (!cancelled) setImageGray({ gray, w, h, s, best })
      } catch {
        if (!cancelled) setImageGray(null)
      }
    }
    img.src = imageUrl
    return () => { cancelled = true }
  }, [imageUrl, imageSize])

  useEffect(() => {
    const img = new Image(); img.src = imageUrl
    img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
  }, [imageUrl])

  // --- Auto-détection faciale ---
  const [faceEstimate, setFaceEstimate] = useState(false) // true = repères estimés par proportions, à vérifier
  // Positions de RÉFÉRENCE (détection auto ou coordonnées du backend) : c'est vers
  // elles que le bouton « Réinitialiser » ramène les repères.
  const [initialPts, setInitialPts] = useState(null)

  useEffect(() => {
    if (!imageSize) return

    // Si coordonnées fournies par le backend → les utiliser directement
    if (initialLeftEye && initialRightEye && initialBridge) {
      setLeftEye(initialLeftEye)
      setRightEye(initialRightEye)
      setBridge(initialBridge)
      setInitialPts({ left: initialLeftEye, right: initialRightEye, bridge: initialBridge })
      setFaceEstimate(false)
      setFaceDetectStatus('success')
      return
    }

    let cancelled = false
    cancelAutoFaceRef.current = false
    setFaceDetectStatus('detecting')
    ;(async () => {
      try {
        const img = new Image(); img.src = imageUrl
        await new Promise(r => { img.onload = r })
        if (cancelled || cancelAutoFaceRef.current) return

        // Cascade unifiée (core/faceDetection) :
        // API native → face-api.js (modèles locaux) → proportions
        const detected = await detectFace(img, imageSize)
        if (cancelled || cancelAutoFaceRef.current) return

        if (detected) {
          setLeftEye(detected.leftEye)
          setRightEye(detected.rightEye)
          if (detected.nose) setBridge(detected.nose)
          setInitialPts({ left: detected.leftEye, right: detected.rightEye, bridge: detected.nose || null })
          setFaceEstimate(detected.method === 'proportions')
          setFaceDetectStatus('success')
        } else {
          setFaceEstimate(false)
          setFaceDetectStatus('failed')
        }
      } catch {
        if (!cancelled) {
          setFaceEstimate(false)
          setFaceDetectStatus('failed')
        }
      }
    })()

    // Timeout 15s → fail
    const timeoutId = setTimeout(() => {
      if (!cancelled) {
        cancelAutoFaceRef.current = true
        setFaceEstimate(false)
        setFaceDetectStatus('failed')
      }
    }, 15000)

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [imageUrl, imageSize, calibration, initialLeftEye, initialRightEye, initialBridge])

  const getImageDisplayRect = useCallback(() => {
    if (!containerRef.current || !imageSize) return null
    const cw = containerRef.current.clientWidth
    const ch = containerRef.current.clientHeight
    if (!cw || !ch) return null
    const cAspect = cw / ch
    const iAspect = imageSize.width / imageSize.height
    if (iAspect > cAspect) {
      const h = cw / iAspect
      return { left: 0, top: (ch - h) / 2, width: cw, height: h }
    }
    const w = ch * iAspect
    return { left: (cw - w) / 2, top: 0, width: w, height: ch }
  }, [imageSize])

  const toImageCoords = useCallback((clientX, clientY) => {
    if (!containerRef.current || !imageSize) return null
    const dr = getImageDisplayRect()
    if (!dr) return null
    const containerRect = containerRef.current.getBoundingClientRect()
    const bl = containerRef.current.clientLeft
    const bt = containerRef.current.clientTop
    const rx = clientX - containerRect.left - bl - dr.left
    const ry = clientY - containerRect.top - bt - dr.top
    const cx = Math.max(0, Math.min(dr.width, rx))
    const cy = Math.max(0, Math.min(dr.height, ry))
    return { x: (cx / dr.width) * imageSize.width, y: (cy / dr.height) * imageSize.height }
  }, [imageSize, getImageDisplayRect])

  const getDefaultBoxSize = useCallback(() => coreDefaultBoxSize(calibration?.scalePxToMm), [calibration])

  // ── Réinitialiser — remet les mesures ET les positions à leur état initial ──
  // Les repères reviennent à leur position de référence (détection auto ou
  // coordonnées du backend), les boîtes et le diamètre sont effacés.
  // Indispensable : on DÉVERROUILLE tout. Sans cela, un repère effacé restait
  // marqué comme verrouillé et ne pouvait plus être reposé (défaut constaté).
  const resetAll = () => {
    if (initialPts) {
      setLeftEye(initialPts.left)
      setRightEye(initialPts.right)
      setBridge(initialPts.bridge)
    } else {
      setLeftEye(null); setRightEye(null); setBridge(null)
    }
    setBoxOG(null)
    setBoxOD(null)
    boxDuplicated.current = false
    setLensRadiusOG(null); setLensRadiusOD(null)
    setLensCenterOG(null); setLensCenterOD(null)
    lockedRef.current = new Set()
    setLockVersion(v => v + 1)
    setActiveMarker(null)
    activeMarkerRef.current = null
  }

  // --- Drag du rayon du cercle (diamètre verre à commander) ---
  const dragLensRef = useRef(null) // { startClient, eye, box, scale, side, setRadius }
  useEffect(() => {
    const onMove = (e) => {
      const d = dragLensRef.current
      if (!d) return
      const clientX = e.touches ? e.touches[0].clientX : e.clientX
      const clientY = e.touches ? e.touches[0].clientY : e.clientY
      const currImg = toImageCoords(clientX, clientY)
      if (!currImg) return
      const rPx = Math.max(1, Math.hypot(currImg.x - d.cx, currImg.y - d.cy))
      // borne max = 55% diagonale image (limites photo)
      const maxR = 0.55 * Math.hypot(imageSize.width, imageSize.height)
      d.setRadius(Math.min(rPx, maxR))
    }
    const onUp = () => { dragLensRef.current = null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onUp)
    }
  }, [toImageCoords, imageSize])

  const startLensDrag = (e, eye, box, scale, side, setRadius, setCenter) => {
    e.stopPropagation()
    e.preventDefault()
    // Geler le centre du cercle à la position de la pupille au moment du drag :
    // le Ø verre choisi est une DÉCISION indépendante du déplacement ultérieur des marqueurs.
    if (setCenter) setCenter({ x: eye.x, y: eye.y })
    // On drag le RAYON depuis ce centre gelé (pas la pupille live, qui a pu bouger)
    dragLensRef.current = { cx: eye.x, cy: eye.y, box, scale, side, setRadius }
  }

  // --- Routine isolée : cercles Ø verre à commander + poignées ---
  // Appelée par le bouton "◎ Diamètre". Rendu SVG avec viewBox en COORDONNÉES IMAGE
  // (même méthode éprouvée que BoxingRect) → cercle parfaitement isotrope,
  // indépendant du letterboxing et des pourcentages CSS.
  const renderLensCircles = () => {
    if (!imageSize) return null
    const scale = calibration?.scalePxToMm
    const getRPx = (radiusState) => radiusState != null ? radiusState
      : (scale ? (DEFAULT_LENS_DIAMETER_MM / 2) / scale : Math.round(imageSize.width * 0.09))
    const getCenter = (eye, centerState) => centerState || eye

    const circles = [
      { eye: leftEye, side: 'OG', radiusState: lensRadiusOG, centerState: lensCenterOG },
      { eye: rightEye, side: 'OD', radiusState: lensRadiusOD, centerState: lensCenterOD },
    ].filter(c => c.eye)

    if (!circles.length) return null

    return (
      <>
        {/* Cercles pointillés — SVG plein overlay, coordonnées image via viewBox */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ zIndex: 14 }}
          viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="none">
          {circles.map(({ eye, side, radiusState, centerState }) => {
            const { x: cx, y: cy } = getCenter(eye, centerState)
            const rPx = getRPx(radiusState)
            const radiusMm = scale ? Math.round(rPx * scale * 10) / 10 : null
            const diaMm = radiusMm != null ? Math.round(2 * radiusMm * 10) / 10 : null
            return (
              <g key={side}>
                <circle cx={cx} cy={cy} r={rPx}
                  fill="rgba(59,158,255,0.06)"
                  stroke="#3b9eff" strokeWidth="1.5" strokeDasharray="5 3"
                  opacity="0.7"
                  vectorEffect="non-scaling-stroke" />
                <text x={cx} y={cy + 4} textAnchor="middle"
                  fill="#3b9eff" fontSize="22" fontWeight="700"
                  stroke="rgba(0,0,0,0.85)" strokeWidth="0.6" paintOrder="stroke">
                  {diaMm != null ? `⌀ ${diaMm} mm` : '⌀ —'}
                </text>
              </g>
            )
          })}
        </svg>
        {/* Poignées dragables — divs HTML positionnées en % (reçoivent les events) */}
        {circles.map(({ eye, side }) => {
          const radiusState = side === 'OG' ? lensRadiusOG : lensRadiusOD
          const setRadius = side === 'OG' ? setLensRadiusOG : setLensRadiusOD
          const setCenter = side === 'OG' ? setLensCenterOG : setLensCenterOD
          const centerState = side === 'OG' ? lensCenterOG : lensCenterOD
          const { x: cx, y: cy } = getCenter(eye, centerState)
          const rPx = getRPx(radiusState)
          const hxPct = (cx / imageSize.width) * 100
          const hyPct = ((cy + rPx) / imageSize.height) * 100
          return (
            <div key={`h-${side}`} style={{
              position: 'absolute', left: `${hxPct}%`, top: `${hyPct}%`,
              width: 22, height: 22, marginLeft: -11, marginTop: -11,
              borderRadius: '50%', background: 'rgba(255,255,255,0.95)',
              border: '2px solid rgba(0,0,0,0.55)', boxShadow: '0 0 6px rgba(0,0,0,0.6)',
              zIndex: 16, touchAction: 'none', cursor: 'grab',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }} data-lenshandle={side}
              onPointerDown={(e) => startLensDrag(e, eye, null, scale, side, setRadius, setCenter)}
              onTouchStart={(e) => startLensDrag(e, eye, null, scale, side, setRadius, setCenter)}>
              <span style={{
                fontSize: 8, fontWeight: 800, color: '#111',
                fontFamily: 'monospace', lineHeight: 1, pointerEvents: 'none',
              }}>{side === 'OG' ? 'DD' : 'DG'}</span>
            </div>
          )
        })}
      </>
    )
  }

  // --- Calculs (logique centralisée dans core/optics.js — testée) ---
  const result = (() => {
    if (!imageSize) return null
    // Échelle : exclusivement depuis la calibration backend
    const scale = calibration?.scalePxToMm || null
    const confiance = calibration?.confidence || 'moyenne'
    const pontOk = !!bridge
    const pupilsOk = !!(leftEye && rightEye)

    // DP monoculaires + binoculaire — distance euclidienne (core)
    const { pdOD, pdOG, pdBinoc } = calculateMonocularPD(leftEye, rightEye, bridge, scale)

    // Sans pont posé : repli historique = moitié de la DP binoculaire
    let monoOG = pdOG ?? null
    let monoOD = pdOD ?? null
    if (monoOG == null && monoOD == null && pdBinoc) {
      monoOG = Math.round((pdBinoc / 2) * 10) / 10
      monoOD = monoOG
    }

    const boxOGOk = boxOG && boxOG.width > 0 && boxOG.height > 0
    const boxODOk = boxOD && boxOD.width > 0 && boxOD.height > 0
    const frameOk = boxOGOk || boxODOk

    // Pont (EIV) + dimensions boxing — core, testé
    const pontMm = calculatePont(boxOG, boxOD, scale)
    const { largeurOD, largeurOG, hauteurCalibre, hauteurMontageOG, hauteurMontageOD } =
      calculateBoxingDimensions(boxOG, boxOD, leftEye, rightEye, scale)

    // Diamètre du verre à commander — 100% MANUEL, centré sur la PUPILLE (centre optique).
    // Ne dépend PAS du rectangle boxing : le Ø est une décision de l'opticien, centrée sur la
    // pupille. Défaut = Ø standard 60mm, ajusté au drag du cercle.
    const lensOG = (leftEye && scale) ? resolveLensDiameter(leftEye, scale, lensRadiusOG) : null
    const lensOD = (rightEye && scale) ? resolveLensDiameter(rightEye, scale, lensRadiusOD) : null
    const lensDiameterOG = lensOG?.diameterMm ?? null
    const lensDiameterOD = lensOD?.diameterMm ?? null
    // Ø retenu = max des deux yeux (ébauche par paire) ; défaut = 60mm standard
    const diameterCommander = (lensOG && lensOD)
      ? Math.max(lensOG.diameterMm, lensOD.diameterMm)
      : (lensOG?.diameterMm ?? lensOD?.diameterMm ?? null)

    return {
      pd: pdBinoc ?? null,
      pdMonoculaireGauche: monoOG ?? null,
      pdMonoculaireDroit: monoOD ?? null,
      pont: pontMm,
      pontOk, pupilsOk, frameOk,
      largeurOG, largeurOD, hauteurCalibre, hauteurMontageOG, hauteurMontageOD,
      confiance,
      methode: calibration ? 'calibration_monture_reference' : 'marquage_manuel',
      // Diamètre verre à commander — saisie manuelle seule (Ø retenu, pas de min théorique auto)
      lensDiameterOG, lensDiameterOD, diameterCommander,
    }
  })()

  const measurementReady = isFrontMeasurementReady({ calibration, leftEye, rightEye, bridge, boxOG, boxOD })

  const confirm = async () => {
    if (!result) return
    // Capture de l'image annotée (avec tous les marqueurs) pour l'export PDF /
    // la sauvegarde backend. Tolérant : si la capture échoue, on continue sans.
    let annotatedImageUrl = null
    try {
      const container = document.getElementById('pupil-image-container')
      if (container) {
        const { default: html2canvas } = await import('html2canvas')
        const canvas = await html2canvas(container, {
          scale: 2,
          backgroundColor: '#0f0f12',
          useCORS: true,
          logging: false,
          allowTaint: true,
        })
        annotatedImageUrl = canvas.toDataURL('image/png')
      }
    } catch { /* capture non bloquante */ }
    onConfirm({
      ...result,
      pdBinoculaire: result.pd,
      pontPlace: result.pontOk,
      annotatedImageUrl,
      calibration: calibration ? { scalePxToMm: Math.round(calibration.scalePxToMm * 1000) / 1000, variation: calibration.scaleVariation } : undefined,
    })
  }

  // Couleurs plus vives et saturées pour contraste sur photo
  const BRIDGE_COLOR = '#00ff7f'      // vert néon vif
  const BOX_COLOR = '#ff2dd0'         // magenta vif (verre)
  const PUPIL_L_COLOR = '#3b9eff'     // bleu éclatant (OD — gauche écran)
  const PUPIL_R_COLOR = '#ffcc00'     // or pur vif (OG — droite écran)

  // ── Verrouillage des marqueurs + duplication rectangle (one-shot) ──
  const boxDuplicated = useRef(false)
  const lockedRef = useRef(new Set())
  const [, setLockVersion] = useState(0)
  const toggleLock = (id) => {
    // Duplication rectangle si on verrouille un box et que l'autre n'existe pas encore
    // Miroir par rapport au centre du nez — logique core (mirrorBox), testée.
    if (id === 'boxOG' && boxOG && !boxOD && !boxDuplicated.current) {
      setBoxOD(mirrorBox(bridge, boxOG))
      boxDuplicated.current = true
    }
    if (id === 'boxOD' && boxOD && !boxOG && !boxDuplicated.current) {
      setBoxOG(mirrorBox(bridge, boxOD))
      boxDuplicated.current = true
    }
    const next = new Set(lockedRef.current)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
      // Si on verrouille, désactiver le marqueur actif s'il correspond
      if (activeMarkerRef.current === id) {
        setActiveMarker(null)
        activeMarkerRef.current = null
      }
    }
    lockedRef.current = next
    setLockVersion(v => v + 1)
  }
  // isLocked n'a pas besoin de useCallback — lockVersion dans la closure force recalcul
  const isLocked = (id) => lockedRef.current.has(id)

  // ── Drag state for markers ──
  const [dragMarker, setDragMarker] = useState(null)
  const currentPosRef = useRef({ bridge: null, left: null, right: null })
  const activeMarkerRef = useRef('bridge')

  // Keep refs in sync with state (for use inside window event listeners)
  useEffect(() => {
    currentPosRef.current = { bridge, left: leftEye, right: rightEye }
  }, [bridge, leftEye, rightEye])
  useEffect(() => {
    activeMarkerRef.current = activeMarker
  }, [activeMarker])

  // Attach window-level listeners during drag so we never lose the pointer
  useEffect(() => {
    if (!dragMarker) return

    const onMove = (e) => {
      // If marker became locked mid-drag, abort
      if (lockedRef.current.has(dragMarker.markerId)) {
        setDragMarker(null)
        return
      }
      // Compute delta
      const startImg = toImageCoords(dragMarker.startClient.x, dragMarker.startClient.y)
      const currImg = toImageCoords(e.clientX, e.clientY)
      if (!startImg || !currImg) return
      const dx = currImg.x - startImg.x
      const dy = currImg.y - startImg.y
      const newPos = { x: dragMarker.startPos.x + dx, y: dragMarker.startPos.y + dy }
      const setters = { bridge: setBridge, left: setLeftEye, right: setRightEye }
      if (setters[dragMarker.markerId]) setters[dragMarker.markerId](newPos)
    }

    const onUp = () => setDragMarker(null)

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragMarker, toImageCoords])

  // ── Panel drag — like BoxingRect, attach via ref + window listeners ──
  const handlePanelPointerDown = useCallback((e) => {
    e.stopPropagation()
    e.preventDefault()
    e.target.setPointerCapture(e.pointerId)
    const container = containerRef.current
    const containerW = container?.getBoundingClientRect().width || 0
    const containerH = container?.getBoundingClientRect().height || 0
    const cur = panelPos || { x: 12, y: containerH / 2 - 120 }
    panelDragRef.current = {
      startX: e.clientX, startY: e.clientY,
      baseX: cur.x, baseY: cur.y,
      containerW, containerH,
    }
  }, [panelPos])

  const handlePanelPointerMove = useCallback((e) => {
    const d = panelDragRef.current
    if (!d) return
    const newX = Math.max(0, Math.min(d.baseX + (e.clientX - d.startX), d.containerW - 180))
    const newY = Math.max(0, Math.min(d.baseY + (e.clientY - d.startY), d.containerH - 240))
    setPanelPos({ x: newX, y: newY })
  }, [])

  const handlePanelPointerUp = useCallback((e) => {
    if (panelDragRef.current) {
      try { e.target.releasePointerCapture(e.pointerId) } catch {}
    }
    panelDragRef.current = null
  }, [])

  // ── Container pointer down: detect marker hit or place new marker ──
  // ── Pointage assisté ────────────────────────────────────────────────────────
  // Au doigt, la cible est masquée par le doigt lui-même. En mode assisté, un
  // contact ne pose plus le repère : il ouvre la VISÉE (loupe de 8 mm suivant le
  // doigt, rendue au-dessus pour ne pas être cachée), et la pose a lieu au
  // RELÂCHEMENT. Activé d'office quand la détection automatique a ÉCHOUÉ (aucun
  // repère posé) : c'est exactement le cas où tout repose sur le pointage manuel.
  // `assistOverride` : null = décision automatique (échec de la détection) ;
  // true/false = choix explicite de l'utilisateur, qui PRIME sur l'automatique —
  // sans cela, le bouton ne pouvait pas désactiver le mode en cas d'échec.
  const [assistOverride, setAssistOverride] = useState(null)
  const [aim, setAim] = useState(null)   // { x, y, target } — cible figée au CONTACT
  const nextMarkerId = !bridge ? 'bridge' : !leftEye ? 'left' : !rightEye ? 'right' : null
  const assistAuto = faceDetectStatus === 'failed'
  const assistOn = assistOverride ?? assistAuto
  // Le mode reste disponible même quand les 3 repères sont posés : il sert alors
  // à REPOSITIONNER finement un repère déjà en place (lunettes, reflets…), ce qui
  // est précisément le cas où l'on veut vérifier à la loupe.
  const assistActive = assistOn

  // Repère visé : le prochain manquant s'il en reste, sinon le plus proche du point
  // touché. La cible est figée au contact pour que la loupe ne change pas de couleur
  // pendant le glissement du doigt.
  const aimTargetAt = useCallback((pt) => {
    if (nextMarkerId) return nextMarkerId
    const cands = [['bridge', bridge], ['left', leftEye], ['right', rightEye]].filter(([, q]) => q)
    if (!cands.length) return null
    return cands.reduce((best, c) => (
      Math.hypot(c[1].x - pt.x, c[1].y - pt.y) < Math.hypot(best[1].x - pt.x, best[1].y - pt.y) ? c : best
    ))[0]
  }, [nextMarkerId, bridge, leftEye, rightEye])
  const AIM_COLOR = { bridge: BRIDGE_COLOR, left: PUPIL_L_COLOR, right: PUPIL_R_COLOR }
  const AIM_LABEL = { bridge: 'Nez', left: 'OD', right: 'OG' }

  // Pose effective du premier repère manquant, dans l'ordre du travail réel.
  // AUCUN test de verrou : un repère absent ne peut pas être « verrouillé », et
  // ce test empêchait de le reposer après un effacement.
  const placeAt = useCallback((pt, target) => {
    const cur = currentPosRef.current
    // Repère absent → on le pose ; repère déjà posé → on le déplace.
    // Un repère VERROUILLÉ ne bouge pas, comme au glissement (règle unique).
    const id = target || (!cur.bridge ? 'bridge' : !cur.left ? 'left' : !cur.right ? 'right' : null)
    if (!id || lockedRef.current.has(id)) return
    if (id === 'bridge') setBridge(pt)
    else if (id === 'left') setLeftEye(pt)
    else setRightEye(pt)
  }, [])

  const handleContainerPointerMove = useCallback((e) => {
    if (!assistActive || !aim) return
    const c = toImageCoords(e.clientX, e.clientY)
    // On conserve la cible choisie au contact : la loupe garde sa couleur et son
    // étiquette pendant tout le glissement du doigt.
    if (c) setAim((a) => ({ x: Math.round(c.x), y: Math.round(c.y), target: a && a.target }))
  }, [assistActive, aim, toImageCoords])

  const handleContainerPointerUp = useCallback((e) => {
    if (!assistActive || !aim) return
    const c = toImageCoords(e.clientX, e.clientY)
    const pt = c ? { x: Math.round(c.x), y: Math.round(c.y) } : { x: aim.x, y: aim.y }
    placeAt(pt, aim.target)
    setAim(null)
  }, [assistActive, aim, toImageCoords, placeAt])

  const handleContainerPointerDown = useCallback((e) => {
    // Walk up DOM to find a marker (data-markerid)
    let target = e.target
    while (target && target !== containerRef.current) {
      if (target.dataset?.markerid) {
        const markerId = target.dataset.markerid
        const startPos = currentPosRef.current[markerId]
        if (!startPos) return
        // Check lock via ref (always up-to-date)
        if (lockedRef.current.has(markerId)) return
        e.preventDefault()
        setActiveMarker(markerId)
        setDragMarker({ markerId, startClient: { x: e.clientX, y: e.clientY }, startPos: { ...startPos } })
        return
      }
      target = target.parentElement
    }
    // Pas sur un repère → un tap pose LE PREMIER REPÈRE MANQUANT (Pont → OD → OG).
    // Plus de bouton de sélection : l'ordre du code suit l'ordre du travail réel.
    const coords = toImageCoords(e.clientX, e.clientY)
    if (!coords) return
    const pt = { x: Math.round(coords.x), y: Math.round(coords.y) }
    // Pointage assisté : on VISE d'abord, on POSE au relâchement (le doigt
    // masquerait la pupille qu'il vise). Hors mode assisté : pose immédiate.
    if (assistActive) { setAim({ ...pt, target: aimTargetAt(pt) }); return }
    placeAt(pt)
    // Tout est posé → un tap à côté ne fait rien (un repère se règle AU DRAG)
    return
  }, [toImageCoords, assistActive, placeAt, aimTargetAt])

  // ── Contrôles objectifs — aucun facteur correctif, uniquement des constats ──
  // Netteté de la zone des yeux rapportée au bloc le plus net de la photo :
  // critère RELATIF, donc indépendant de l'exposition et du niveau de détail.
  const sharpnessRatio = (() => {
    if (!imageGray || !imageGray.best || !leftEye || !rightEye || !imageSize) return null
    const { s } = imageGray
    const regions = eyeRegions(leftEye, rightEye, imageSize, { mmPerPx: calibration?.scalePxToMm })
      .map((r) => ({ x: r.x * s, y: r.y * s, width: r.width * s, height: r.height * s }))
    const scores = regions
      .map((r) => blockSharpness(imageGray.gray, imageGray.w, imageGray.h, r))
      .filter((v) => v > 0)
    if (!scores.length) return null
    return (scores.reduce((a, b) => a + b, 0) / scores.length) / imageGray.best
  })()

  const quality = evaluatePhotoQuality({ calibration, leftEye, rightEye, bridge, imageSize, sharpnessRatio })
  const qualityIssues = quality.filter((c) => c.level !== 'ok').length

  // Réticule du repère — SOURCE UNIQUE : il habille le repère posé sur la photo ET
  // la loupe, qui l'affiche grossi du même facteur que l'image. Deux formes différentes
  // pour le même point (croix dans la loupe, cercle sur la photo) étaient déroutantes :
  // on ne savait plus quel dessin représentait la mesure.
  const reticleNode = (color, sz = 22) => (
    <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
      <circle cx={sz / 2} cy={sz / 2} r="2.5" fill={color} fillOpacity="0.20" stroke="#fff" strokeWidth="0.8" />
    </svg>
  )

  // ── Loupe de précision ──────────────────────────────────────────────────────
  // Instrument PARTAGÉ (components/PrecisionLoupe) : la même loupe sert ici et à
  // l'écran de calibrage. Champ de 12 mm pendant un glissement, resserré à 8 mm en
  // visée — on cherche alors le centre de la pupille, pas l'œil entier.
  const renderLoupe = (dr, aimPoint) => {
    let pos = null, color = null, label = null
    if (aimPoint) {
      pos = aimPoint.pos; color = aimPoint.color; label = aimPoint.label
    } else if (dragMarker) {
      const id = dragMarker.markerId
      pos = { bridge, left: leftEye, right: rightEye }[id]
      color = id === 'bridge' ? BRIDGE_COLOR : id === 'left' ? PUPIL_L_COLOR : PUPIL_R_COLOR
      label = id === 'bridge' ? 'Nez' : id === 'left' ? 'OD' : 'OG'
    }
    if (!pos) return null
    return (
      <PrecisionLoupe dr={dr} imageSize={imageSize} imageUrl={imageUrl} pos={pos}
        color={color} label={label} mmPerPx={calibration?.scalePxToMm || null}
        reticle={reticleNode(color)} reticleSize={22}
        spanMm={aimPoint ? 8 : 12}
        hint={aimPoint ? 'relâcher pour poser' : null} />
    )
  }

  // ── Marqueur ponctuel — le PETIT CERCLE de mesure est lui-même la cible du drag ──
  // (Driss : plus de poignée déportée 75 px au-dessus → la loupe suit directement
  //  la pupille au lieu de flotter à côté du handle)
  const renderCrossMarkerSimple = (pos, color, label, isActive, markerId, sz = 22) => {
    if (!pos || !imageSize) return null
    const l = (pos.x / imageSize.width) * 100
    const t = (pos.y / imageSize.height) * 100
    const HIT = 44      // zone tactile centrée sur le point (invisible, 44 px)

    return (
    <div style={{
      position: 'absolute',
      left: `${l}%`, top: `${t}%`,
      zIndex: 15,
      pointerEvents: 'none',
    }}>
      {/* Réticule de précision — le centre est le point de mesure */}
      <div style={{
        position: 'absolute',
        left: 0, top: 0,
        transform: 'translate(-50%, -50%)',
        filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.95))',
      }}>
        {reticleNode(color, sz)}
      </div>

      {/* Cible tactile : centrée sur le point, invisible, ne masque jamais la mesure */}
      <div data-markerid={markerId} style={{
        position: 'absolute', left: 0, top: 0,
        width: HIT, height: HIT,
        transform: 'translate(-50%, -50%)',
        borderRadius: '50%',
        pointerEvents: 'auto', cursor: 'grab',
        border: `1px solid ${isActive ? color : 'transparent'}`,
        background: isActive ? `${color}18` : 'transparent',
      }} />

      {/* Étiquette — SOUS le point, jamais dessus */}
      <div style={{
        position: 'absolute', left: 0, top: 13,
        transform: 'translateX(-50%)',
        fontSize: '9px', fontWeight: 700, color: color,
        textShadow: '0 1px 2px rgba(0,0,0,0.9)', whiteSpace: 'nowrap',
      }}>{label}</div>
    </div>
    )
    }

  // Création d'une boîte par sa pastille : posée autour du nez, la seconde se
  // génère en miroir au verrouillage (comportement historique conservé).
  // Depuis l'homogénéisation, aucun bouton d'outil n'est nécessaire.
  const createBox = useCallback((which) => {
    if (which === 'boxOG' ? boxOG : boxOD) return
    const b = currentPosRef.current.bridge
    if (!b) return
    const def = getDefaultBoxSize()
    const r = { x: b.x + (which === 'boxOG' ? -def.width / 2 : def.width / 2), y: b.y,
                width: def.width, height: def.height }
    if (which === 'boxOG') setBoxOG(r)
    else setBoxOD(r)
  }, [boxOG, boxOD, getDefaultBoxSize])

  const hasAnyMarker = leftEye || rightEye || bridge || boxOG || boxOD

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-1 h-8 rounded-full shrink-0" style={{ background: 'linear-gradient(to bottom, var(--color-purple), var(--color-purple-light))' }} />
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text)', fontFamily: "'Playfair Display', Georgia, serif" }}>
              Centrage & Monture
            </h2>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Boxing · Pont · Pupilles</p>
          </div>
        </div>
        {onRetake && (
          <button onClick={onRetake} className="flex items-center gap-1 text-xs transition-all hover:opacity-80 shrink-0 ml-2"
            style={{ color: 'var(--color-red)' }}>
            <Camera size={12} /> Reprendre
          </button>
        )}
        <MeasureRuler variant="button"
          scaleMmPerPx={calibration?.scalePxToMm}
          imageSize={imageSize}
          displayRect={getImageDisplayRect()}
          visible={rulerVisible}
          onToggle={() => setRulerVisible(v => !v)} />
      </div>

      {/* Bannière détection faciale */}
      {faceDetectStatus === 'detecting' && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
          style={{ background: 'rgba(201,160,90,0.12)', color: 'var(--color-gold)', border: '1px solid rgba(201,160,90,0.25)' }}>
          <Loader2 size={14} className="animate-spin" />
          <span>Détection automatique du visage en cours…</span>
        </div>
      )}
      {faceDetectStatus === 'failed' && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
          style={{ background: 'var(--color-red-bg)', color: 'var(--color-red)', border: '1px solid rgba(255,107,107,0.25)' }}>
          <span>Détection automatique impossible — Placez les repères manuellement</span>
        </div>
      )}
      {faceDetectStatus === 'success' && faceEstimate && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
          style={{ background: 'rgba(201,160,90,0.12)', color: 'var(--color-gold)', border: '1px solid rgba(201,160,90,0.25)' }}>
          <AlertTriangle size={14} />
          <span>Repères estimés par proportion (aucun visage détecté) — repositionnez-les précisément</span>
        </div>
      )}

      {/* Calibration info row */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        <span className="self-center text-[10px] font-medium" style={{ color: 'var(--color-gold)' }}>Calibrage :</span>
        <span className="self-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {calibration ? '✓ 3 repères placés' : 'Non fait'}
        </span>
      </div>

      {/* Contrôles objectifs — à lire AVANT de valider les mesures */}
      <div className="rounded-xl px-3 py-2.5" data-quality-panel="1"
        style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-semibold" style={{ color: 'var(--color-text-muted)', letterSpacing: '0.05em' }}>
            CONTRÔLES OBJECTIFS
          </span>
          <span className="text-[10px] font-semibold"
            style={{ color: qualityIssues ? 'var(--color-gold)' : 'var(--color-green)' }}>
            {qualityIssues ? `${qualityIssues} point${qualityIssues > 1 ? 's' : ''} à vérifier` : 'tout est conforme'}
          </span>
        </div>
        {quality.map((c) => (
          <div key={c.id} className="flex items-start gap-1.5 py-0.5 text-[11px]"
            style={{ lineHeight: 1.3 }} data-quality={c.id} data-level={c.level}>
            <span className="shrink-0" style={{ color: QUALITY_COLOR[c.level] }}>{QUALITY_ICON[c.level]}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>
              <strong style={{ color: c.level === 'ok' ? 'var(--color-text-muted)' : QUALITY_COLOR[c.level] }}>
                {c.label}
              </strong>
              {' — '}{c.detail}
            </span>
          </div>
        ))}
      </div>

      {/* Repères — état ET verrou sur une seule ligne.
          Pastille grise = absent · ✓ = posé · 🔒 = verrouillé (taper = verrouiller).
          L'état est déjà visible sur l'image (étiquettes colorées sous les points). */}
      <div className="flex items-center gap-1 flex-wrap" data-markers-status="1">
        <span className="text-[10px] font-medium mr-0.5" style={{ color: 'var(--color-text-muted)' }}>Repères :</span>
        {[
          { key: 'bridge', label: 'Pont', color: BRIDGE_COLOR, value: bridge },
          { key: 'left', label: 'OD', color: PUPIL_L_COLOR, value: leftEye },
          { key: 'right', label: 'OG', color: PUPIL_R_COLOR, value: rightEye },
          { key: 'boxOG', label: 'Box OD', color: BOX_COLOR, value: boxOG },
          { key: 'boxOD', label: 'Box OG', color: BOX_COLOR, value: boxOD },
        ].map(({ key, label, color, value }) => {
          const locked = isLocked(key)
          const isBox = key === 'boxOG' || key === 'boxOD'
          // Une pastille de boîte ABSENTE sert à CRÉER la boîte (autour du nez) ;
          // une pastille posée sert à la VERROUILLER. Un seul geste pour les deux.
          const canCreate = isBox && !value && !!bridge
          return (
            <button key={key}
              onClick={() => { if (value) toggleLock(key); else if (canCreate) createBox(key) }}
              disabled={!value && !canCreate}
              data-chip={key} data-locked={locked ? '1' : '0'}
              className="px-2 py-1 rounded-lg text-[11px] font-medium transition-all disabled:opacity-40"
              style={{
                background: value ? (locked ? 'var(--color-green-bg)' : `${color}18`) : 'var(--color-border)',
                color: value ? (locked ? 'var(--color-green)' : color) : 'var(--color-text-dim)',
                border: `1px solid ${value ? (locked ? 'var(--color-green)' : `${color}55`) : 'transparent'}`,
              }}>
              {label} {value ? (locked ? '🔒' : '✓') : (isBox ? '+' : '—')}
            </button>
          )
        })}
      </div>

      {/* Outils */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        <button onClick={() => setLensActive(v => !v)}
          className="flex-1 min-w-[70px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={{
            background: lensActive ? 'rgba(6,182,212,0.16)' : 'var(--color-border)',
            color: lensActive ? '#06b6d4' : 'var(--color-text-dim)',
            border: lensActive ? '1.5px solid #06b6d4' : '1.5px solid transparent',
          }}>
          <span style={{ color: lensActive ? '#06b6d4' : 'var(--color-text-dim)' }}>◎</span>
          Diamètre{lensActive ? ' ✓' : ''}
        </button>
        <button onClick={() => setAssistOverride(!assistOn)} data-tool="assist" data-assist={assistActive ? '1' : '0'}
          className="px-3 py-2 rounded-xl text-xs font-medium transition-opacity disabled:opacity-30 flex items-center gap-1"
          style={{
            background: assistActive ? 'rgba(201,160,90,0.18)' : 'var(--color-card, #1a1a20)',
            color: assistActive ? 'var(--color-gold)' : 'var(--color-text)',
            border: `1px solid ${assistActive ? 'var(--color-gold)' : 'var(--color-border)'}`,
            cursor: 'pointer',
          }}>
          <ZoomIn size={12} /> Pointage assisté
        </button>
        <button onClick={resetAll} disabled={!hasAnyMarker} data-tool="reset"
          className="px-3 py-2 rounded-xl text-xs font-medium transition-opacity disabled:opacity-30 flex items-center gap-1"
          style={{ background: 'var(--color-red-bg)', color: 'var(--color-red)' }}>
          <RotateCcw size={12} /> Réinitialiser
        </button>
        {lensActive && (lensRadiusOG != null || lensRadiusOD != null) && (
          <button onClick={() => { setLensRadiusOG(null); setLensRadiusOD(null); setLensCenterOG(null); setLensCenterOD(null) }}
            className="px-3 py-2 rounded-xl text-xs font-medium transition-opacity flex items-center gap-1"
            style={{ background: 'rgba(6,182,212,0.12)', color: '#06b6d4', border: '1px solid rgba(6,182,212,0.3)' }}>
            <RotateCcw size={12} /> Ø min
          </button>
        )}
      </div>

      {/* Image */}
      <div ref={containerRef} id="pupil-image-container"
        className="relative rounded-2xl border overflow-hidden select-none cursor-crosshair"
        style={{ background: '#08080a', borderColor: 'var(--color-border)', aspectRatio: imageSize ? `${imageSize.width}/${imageSize.height}` : '4/3', touchAction: 'none' }}
        onPointerDown={handleContainerPointerDown}
        onPointerMove={handleContainerPointerMove}
        onPointerUp={handleContainerPointerUp}
        onPointerCancel={() => setAim(null)}
        onPointerLeave={() => setAim(null)}>
        {imageUrl && <img src={imageUrl} alt="Centrage" className="w-full h-full block object-contain" draggable={false} />}

        {/* Image overlay — exact display rect, all markers render inside it with simple % */}
        {imageSize && getImageDisplayRect() && (() => {
          const dr = getImageDisplayRect()
          return (
            <div style={{
              position: 'absolute',
              left: dr.left,
              top: dr.top,
              width: dr.width,
              height: dr.height,
              overflow: 'visible',
            }}>
              {/* Boxing rectangles render via BoxingRect (which handles its own letterboxing) */}
              <BoxingRect rect={boxOG} imageSize={imageSize} toImageCoords={toImageCoords}
                onChange={setBoxOG} active={activeMarker === 'boxOG'} locked={isLocked('boxOG')} color={BOX_COLOR} label="VOD" containerRef={containerRef} />
              <BoxingRect rect={boxOD} imageSize={imageSize} toImageCoords={toImageCoords}
                onChange={setBoxOD} active={activeMarker === 'boxOD'} locked={isLocked('boxOD')} color={BOX_COLOR} label="VOG" containerRef={containerRef} />

              {/* Cercles diamètre verre à commander — 1 par verre, centrés sur la pupille, rayon dragable.
                  Rayon "glacé" à l'activation : indépendant du déplacement des marqueurs OD/OG. */}
              {lensActive && renderLensCircles()}

                            {/* Pupillary lines */}
              {boxOG && leftEye && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 13 }}>
                  <line x1={`${(leftEye.x / imageSize.width) * 100}%`}
                    y1={`${((boxOG.y - boxOG.height / 2) / imageSize.height) * 100}%`}
                    x2={`${(leftEye.x / imageSize.width) * 100}%`}
                    y2={`${((boxOG.y + boxOG.height / 2) / imageSize.height) * 100}%`}
                    stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="5 3" opacity="0.7" />
                  <line x1={`${((leftEye.x - 4) / imageSize.width) * 100}%`}
                    y1={`${(leftEye.y / imageSize.height) * 100}%`}
                    x2={`${((leftEye.x + 4) / imageSize.width) * 100}%`}
                    y2={`${(leftEye.y / imageSize.height) * 100}%`}
                    stroke="#f59e0b" strokeWidth="2" opacity="0.8" />
                </svg>
              )}
              {boxOD && rightEye && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 13 }}>
                  <line x1={`${(rightEye.x / imageSize.width) * 100}%`}
                    y1={`${((boxOD.y - boxOD.height / 2) / imageSize.height) * 100}%`}
                    x2={`${(rightEye.x / imageSize.width) * 100}%`}
                    y2={`${((boxOD.y + boxOD.height / 2) / imageSize.height) * 100}%`}
                    stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="5 3" opacity="0.7" />
                  <line x1={`${((rightEye.x - 4) / imageSize.width) * 100}%`}
                    y1={`${(rightEye.y / imageSize.height) * 100}%`}
                    x2={`${((rightEye.x + 4) / imageSize.width) * 100}%`}
                    y2={`${(rightEye.y / imageSize.height) * 100}%`}
                    stroke="#f59e0b" strokeWidth="2" opacity="0.8" />
                </svg>
              )}

              {/* Bridge markers */}
              {bridge && renderCrossMarkerSimple(bridge, BRIDGE_COLOR, 'Nez', activeMarker === 'bridge', 'bridge')}
              {/* Eye markers */}
              {leftEye && renderCrossMarkerSimple(leftEye, PUPIL_L_COLOR, 'OD', activeMarker === 'left', 'left')}
              {rightEye && renderCrossMarkerSimple(rightEye, PUPIL_R_COLOR, 'OG', activeMarker === 'right', 'right')}

              {/* Loupe de précision — visible pendant le drag d'un repère */}
              {renderLoupe(dr, assistActive && aim && aim.target
                ? { pos: aim, color: AIM_COLOR[aim.target], label: AIM_LABEL[aim.target] }
                : null)}

              {/* Ligne pointillée fine — 25% hauteur, centrée sur le pont */}
                            {bridge && (() => {
                              const bridgeYPct = (bridge.y / imageSize.height) * 100
                              const halfSpan = 12.5 // ±12.5% → 25% total
                              return (
                                <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 10 }}>
                                  <line x1={`${(bridge.x / imageSize.width) * 100}%`}
                                    y1={`${bridgeYPct - halfSpan}%`}
                                    x2={`${(bridge.x / imageSize.width) * 100}%`}
                                    y2={`${bridgeYPct + halfSpan}%`}
                                    stroke="rgba(0, 255, 127, 0.45)" strokeWidth="1" strokeDasharray="5 3" />
                                </svg>
                              )
                            })()}

              {/* Panneau live — DP / DPD / DPG en temps réel */}
              {leftEye && rightEye && (() => {
                // Source unique : le panneau live affiche exactement les valeurs du moteur métier.
                const formatMm = (value) => value == null ? '—' : Number(value).toFixed(1)
                const dp = formatMm(result?.pd)
                const dpd = formatMm(result?.pdMonoculaireDroit)
                const dpg = formatMm(result?.pdMonoculaireGauche)
                const pont = formatMm(result?.pont)
                const hCal = formatMm(result?.hauteurCalibre)
                const lCalG = formatMm(result?.largeurOG)
                const lCalD = formatMm(result?.largeurOD)
                // Nommage historique du résultat : hauteurMontageOG correspond au verre OD (gauche image).
                const hMontG = formatMm(result?.hauteurMontageOG)
                const hMontD = formatMm(result?.hauteurMontageOD)
                const widths = [result?.largeurOG, result?.largeurOD].filter(v => v != null)
                const averageWidth = widths.length ? widths.reduce((sum, v) => sum + v, 0) / widths.length : null
                const em = averageWidth != null && result?.pont != null
                  ? formatMm(averageWidth + result.pont / 2)
                  : '—'
                const containerH = (containerRef.current?.getBoundingClientRect()?.height) || 0
                const pos = panelPos || { x: 12, y: containerH / 2 - 120 }
                return (
                  <div
                    ref={panelRef}
                    onPointerDown={handlePanelPointerDown}
                    onPointerMove={handlePanelPointerMove}
                    onPointerUp={handlePanelPointerUp}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      top: `${pos.y}px`,
                      left: `${pos.x}px`,
                      zIndex: 35,
                      position: 'absolute',
                      cursor: panelDragRef.current ? 'grabbing' : 'grab',
                      touchAction: 'none',
                      userSelect: 'none',
                      background: 'rgba(15,15,18,0.92)',
                      border: '1px solid #c9a05a',
                      borderRadius: '10px',
                      padding: '8px 12px',
                      fontFamily: 'monospace',
                      minWidth: '160px',
                      maxWidth: '200px',
                      boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '6px' }}>
                      <span style={{ color: '#888', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>DP</span>
                      <span style={{ color: '#c9a05a', fontSize: '18px', fontWeight: '700' }}>{dp} mm</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '4px' }}>
                      <span style={{ color: '#888', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>DPG (OG)</span>
                      <span style={{ color: '#c9a05a', fontSize: '14px', fontWeight: '600' }}>{dpg} mm</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '4px' }}>
                      <span style={{ color: '#888', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>DPD (OD)</span>
                      <span style={{ color: '#c9a05a', fontSize: '14px', fontWeight: '600' }}>{dpd} mm</span>
                    </div>
                    <div style={{ height: '1px', background: 'rgba(201,160,90,0.3)', margin: '6px 0' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' }}>
                      <span style={{ color: '#888', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Pont</span>
                      <span style={{ color: '#22c55e', fontSize: '14px', fontWeight: '600' }}>{pont} mm</span>
                    </div>
                    <div style={{ height: '1px', background: 'rgba(201,160,90,0.3)', margin: '6px 0' }} />
                    <div style={{ fontSize: '9px', color: '#8b5cf6', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>Dimensions monture</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '4px' }}>
                      <span style={{ color: '#888', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>H. Calibre</span>
                      <span style={{ color: '#8b5cf6', fontSize: '14px', fontWeight: '600' }}>{hCal} mm</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '4px' }}>
                      <span style={{ color: '#888', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>L. Calibre OD/OG</span>
                      <span style={{ color: '#8b5cf6', fontSize: '13px', fontWeight: '600' }}>{lCalG} / {lCalD} mm</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '4px' }}>
                      <span style={{ color: '#888', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>H. Mont. OD</span>
                      <span style={{ color: '#8b5cf6', fontSize: '14px', fontWeight: '600' }}>{hMontG} mm</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' }}>
                      <span style={{ color: '#888', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>H. Mont. OG</span>
                      <span style={{ color: '#8b5cf6', fontSize: '14px', fontWeight: '600' }}>{hMontD} mm</span>
                    </div>
                    <div style={{ height: '1px', background: 'rgba(139,92,246,0.3)', margin: '6px 0' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' }}> 
                      <span style={{ color: '#888', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Em</span>
                      <span style={{ color: '#f59e0b', fontSize: '14px', fontWeight: '700' }}>{em} mm</span>
                    </div>
                    <div style={{ height: '1px', background: 'rgba(6,182,212,0.3)', margin: '6px 0' }} />
                    {lensActive && (<>
                      <div style={{ fontSize: '9px', color: '#06b6d4', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>Ø Verre à commander</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' }}>
                        <span style={{ color: '#888', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Ø retenu (régler au drag)</span>
                        <span style={{ color: '#06b6d4', fontSize: '14px', fontWeight: '600' }}>{result?.diameterCommander != null ? `${result.diameterCommander} mm` : '—'}</span>
                      </div>
                    </>)}
                  </div>
                )
              })()}

              {/* Réglette métrologique (bouton header → visible) */}
              <MeasureRuler variant="ruler"
                scaleMmPerPx={calibration?.scalePxToMm}
                imageSize={imageSize}
                displayRect={dr}
                visible={rulerVisible}
                onToggle={() => setRulerVisible(v => !v)} />
            </div>
          )
        })()}

        <div className="absolute bottom-3 left-0 right-0 text-center pointer-events-none" style={{ zIndex: 50 }}>
          <span className="inline-block px-3 py-1.5 rounded-full text-xs"
            style={{ background: 'rgba(0,0,0,0.7)', color: '#ccc', border: '1px solid rgba(255,255,255,0.1)' }}>
            {result?.pupilsOk && result?.pontOk && (boxOG || boxOD) ? 'Tous les repères placés · Validez'
              : !bridge ? 'Tapez pour placer le centre du nez'
              : !leftEye ? 'Tapez pour placer la pupille OD'
              : !rightEye ? 'Tapez pour placer la pupille OG'
              : 'Touchez Box OD ou Box OG pour créer les boîtes'}
          </span>
        </div>
      </div>

      {/* Live measurements */}
      {result && (
        <div className="rounded-xl p-4 space-y-3 border" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
          {/* PD */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>DP Binoculaire</div>
              <div className="text-2xl font-bold" style={{ color: 'var(--color-text)' }}>{result.pd} <span className="text-sm" style={{ color: 'var(--color-text-dim)' }}>mm</span></div>
            </div>
            <div className="text-right text-xs space-y-0.5" style={{ color: 'var(--color-text-muted)' }}>
              <div>OG : {result.pdMonoculaireGauche} mm</div>
              <div>OD : {result.pdMonoculaireDroit} mm</div>
            </div>
          </div>

          {/* Pont + Calibre */}
          <div className="grid grid-cols-3 gap-2 pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <div className="text-center py-1.5 rounded-lg" style={{ background: result.pontOk ? 'var(--color-green-bg)' : 'var(--color-bg)' }}>
              <div className="text-[9px] uppercase" style={{ color: 'var(--color-text-muted)' }}>Pont</div>
              <div className="text-sm font-bold" style={{ color: result.pontOk ? 'var(--color-green)' : 'var(--color-text-dim)' }}>
                {result.pontOk ? `${result.pont} mm` : '—'}
              </div>
            </div>
            <div className="text-center py-1.5 rounded-lg" style={{ background: result.frameOk ? 'var(--color-purple-bg)' : 'var(--color-bg)' }}>
              <div className="text-[9px] uppercase" style={{ color: 'var(--color-text-muted)' }}>H. Calibre</div>
              <div className="text-sm font-bold" style={{ color: result.frameOk ? 'var(--color-purple)' : 'var(--color-text-dim)' }}>
                {result.frameOk ? `${result.hauteurCalibre} mm` : '—'}
              </div>
            </div>
            <div className="text-center py-1.5 rounded-lg" style={{ background: result.frameOk ? 'var(--color-purple-bg)' : 'var(--color-bg)' }}>
              <div className="text-[9px] uppercase" style={{ color: 'var(--color-text-muted)' }}>L. Calibre</div>
              <div className="text-sm font-bold" style={{ color: result.frameOk ? 'var(--color-purple)' : 'var(--color-text-dim)' }}>
                {result.frameOk ? `${result.largeurOD ?? '—'}/${result.largeurOG ?? '—'}` : '—'}
              </div>
            </div>
          </div>

          {/* H. Montage */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="text-center py-1.5 rounded-lg" style={{ background: result.hauteurMontageOG != null ? 'var(--color-purple-bg)' : 'var(--color-bg)' }}>
              <div className="text-[9px] uppercase" style={{ color: 'var(--color-text-muted)' }}>H. Montage OD</div>
              <div className="text-sm font-bold" style={{ color: result.hauteurMontageOG != null ? 'var(--color-purple)' : 'var(--color-text-dim)' }}>
                {result.hauteurMontageOG != null ? `${result.hauteurMontageOG} mm` : '—'}
              </div>
            </div>
            <div className="text-center py-1.5 rounded-lg" style={{ background: result.hauteurMontageOD != null ? 'var(--color-purple-bg)' : 'var(--color-bg)' }}>
              <div className="text-[9px] uppercase" style={{ color: 'var(--color-text-muted)' }}>H. Montage OG</div>
              <div className="text-sm font-bold" style={{ color: result.hauteurMontageOD != null ? 'var(--color-purple)' : 'var(--color-text-dim)' }}>
                {result.hauteurMontageOD != null ? `${result.hauteurMontageOD} mm` : '—'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        {onBack && (
          <button onClick={onBack}
            className="flex items-center justify-center gap-1.5 flex-1 py-3 rounded-full font-medium text-sm transition-all hover:opacity-80"
            style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
            <ChevronLeft size={16} /> Retour
          </button>
        )}
        <button onClick={confirm} disabled={!measurementReady}
          className="flex items-center justify-center gap-1.5 flex-1 py-3 rounded-full font-medium text-sm text-white transition-all hover:opacity-90 disabled:opacity-40"
          style={{ background: 'var(--color-gold)' }}>
          <Check size={16} /> Valider la mesure
        </button>
      </div>

      {!measurementReady && (
        <div className="text-center">
          <p className="text-xs" style={{ color: 'var(--color-gold)' }}>
            {!calibration?.scalePxToMm ? '⚠️ Calibration physique requise pour valider des mesures en millimètres. ' : ''}
            {calibration?.scalePxToMm && !bridge ? '💡 Placez le Centre du Nez pour la DP monoculaire. ' : ''}
            {calibration?.scalePxToMm && (!boxOG || !boxOD) ? '💡 Placez les deux rectangles boxing. ' : ''}
            {calibration?.scalePxToMm && boxOG && boxOD && result?.pont == null ? '⚠️ Les calibres se croisent : corrigez leur position.' : ''}
          </p>
        </div>
      )}
    </div>
  )
}
