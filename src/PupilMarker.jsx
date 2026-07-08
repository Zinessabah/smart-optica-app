import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronLeft, RotateCcw, ZoomIn, ZoomOut, Camera, Check } from 'lucide-react'
import Loupe from './Loupe'
import BoxingRect from './BoxingRect'

export default function PupilMarker({ imageUrl, calibration, onConfirm, onBack, onRetake }) {
  const [imageSize, setImageSize] = useState(null)
  const [leftEye, setLeftEye] = useState(null)
  const [rightEye, setRightEye] = useState(null)
  const [bridgeL, setBridgeL] = useState(null)
  const [bridgeR, setBridgeR] = useState(null)
  const [boxOG, setBoxOG] = useState(null)
  const [boxOD, setBoxOD] = useState(null)
  const [activeMarker, setActiveMarker] = useState('bridgeL')
  const [loupeZoom, setLoupeZoom] = useState(3)
  const [loupePos, setLoupePos] = useState(null)
  const containerRef = useRef(null)

  useEffect(() => {
    const img = new Image(); img.src = imageUrl
    img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
  }, [imageUrl])

  // --- Auto-détection faciale ---
  useEffect(() => {
    if (!imageSize) return
    let cancelled = false
    ;(async () => {
      try {
        const img = new Image(); img.src = imageUrl
        await new Promise(r => { img.onload = r })
        let eyesFound = false

        // 1) FaceDetector API native
        if (typeof window.FaceDetector !== 'undefined') {
          const faces = await new window.FaceDetector({ maxDetectedFaces: 1, fastMode: false }).detect(await createImageBitmap(img))
          if (!cancelled && faces.length > 0) {
            const f = faces[0]
            if (f.landmarks) {
              const eyes = f.landmarks.filter(l => l.type === 'eye')
              const nose = f.landmarks.filter(l => l.type === 'nose')
              if (eyes.length >= 2) {
                setLeftEye(c(eyes[0].locations)); setRightEye(c(eyes[1].locations))
                eyesFound = true
              }
              if (nose.length > 0) {
                const nc = c(nose[0].locations)
                const halfGap = getBridgeHalfGapPx(calibration, imageSize)
                setBridgeL({ x: nc.x - halfGap, y: nc.y })
                setBridgeR({ x: nc.x + halfGap, y: nc.y })
              }
              if (eyesFound) return
            }
            // Fallback bounding box proportions
            const b = f.boundingBox?.box || f.boundingBox
            const cx = b.x + b.width * 0.50, cy = b.y + b.height * 0.62
            setLeftEye({ x: b.x + b.width * 0.29, y: b.y + b.height * 0.42 })
            setRightEye({ x: b.x + b.width * 0.71, y: b.y + b.height * 0.42 })
            const halfGap = getBridgeHalfGapPx(calibration, imageSize)
            setBridgeL({ x: cx - halfGap, y: cy }); setBridgeR({ x: cx + halfGap, y: cy })
            return
          }
        }

        // 2) face-api.js
        try {
          const fa = await import('face-api.js')
          await Promise.all([
            fa.nets.tinyFaceDetector.loadFromUri('https://justadudewhohacks.github.io/face-api.js/models'),
            fa.nets.faceLandmarks68Net.loadFromUri('https://justadudewhohacks.github.io/face-api.js/models')
          ])
          const d = await fa.detectSingleFace(img, new fa.TinyFaceDetectorOptions()).withFaceLandmarks()
          if (!cancelled && d?.landmarks) {
            setLeftEye(c(d.landmarks.getLeftEye())); setRightEye(c(d.landmarks.getRightEye()))
            const nose = d.landmarks.getNose()
            if (nose && nose.length >= 3) {
              const nc = c(nose.slice(0, 4))
              const halfGap = getBridgeHalfGapPx(calibration, imageSize)
              setBridgeL({ x: nc.x - halfGap, y: nc.y }); setBridgeR({ x: nc.x + halfGap, y: nc.y })
            }
            return
          }
        } catch (_) {}

        // 3) Proportion estimate
        if (!cancelled) {
          const mx = img.width / 2, my = img.height * 0.42, d = img.width * 0.12
          setLeftEye({ x: mx - d, y: my }); setRightEye({ x: mx + d, y: my })
          const halfGap = getBridgeHalfGapPx(calibration, imageSize)
          setBridgeL({ x: mx - halfGap, y: my + d * 0.9 }); setBridgeR({ x: mx + halfGap, y: my + d * 0.9 })
        }
      } catch (_) {}
    })()
    return () => { cancelled = true }
  }, [imageUrl, imageSize])

  // --- Auto-équilibrage : vérifier symétrie OG/OD par rapport au pont ---
  useEffect(() => {
    if (bridgeL && bridgeR && leftEye && rightEye) {
      const bc = { x: (bridgeL.x + bridgeR.x) / 2, y: (bridgeL.y + bridgeR.y) / 2 }
      const dOG = Math.hypot(leftEye.x - bc.x, leftEye.y - bc.y)
      const dOD = Math.hypot(rightEye.x - bc.x, rightEye.y - bc.y)
      const ratio = Math.max(dOG, dOD) / Math.min(dOG, dOD)

      // Si asymétrie > 10%, on corrige
      if (ratio > 1.10) {
        const avgDist = (dOG + dOD) / 2
        // Recalculer positions symétriques
        const angleOG = Math.atan2(leftEye.y - bc.y, leftEye.x - bc.x)
        const angleOD = Math.atan2(rightEye.y - bc.y, rightEye.x - bc.x)
        // Prendre le côté le plus fiable (celui avec l'angle le plus proche de l'horizontale)
        const absAngleOG = Math.abs(angleOG % Math.PI - Math.PI / 2)
        const absAngleOD = Math.abs(angleOD % Math.PI - Math.PI / 2)
        const refAngle = absAngleOG < absAngleOD ? angleOG : Math.PI - angleOD
        const mirrorX = (a) => -Math.cos(a) * avgDist + bc.x
        const mirrorY = (a) => Math.sin(a) * avgDist + bc.y

        const correctedEye = {
          x: mirrorX(refAngle),
          y: mirrorY(refAngle)
        }
        // Déterminer quel œil corriger
        if (dOG > dOD * 1.10) {
          setLeftEye(correctedEye)
        } else if (dOD > dOG * 1.10) {
          setRightEye(correctedEye)
        }
      }
    }
  }, [bridgeL, bridgeR, leftEye, rightEye])

  // Auto-duplication boxOD depuis boxOG
  useEffect(() => {
    if (activeMarker === 'boxOD' && boxOG && !boxOD) {
      const bridgeCenterX = (bridgeL && bridgeR) ? (bridgeL.x + bridgeR.x) / 2 : boxOG.x
      const ogCenterOffset = boxOG.x - bridgeCenterX
      const mirrorX = bridgeCenterX - ogCenterOffset
      const centerY = boxOG.y
      setBoxOD({ x: mirrorX, y: centerY, width: boxOG.width, height: boxOG.height })
      setRightEye({ x: mirrorX, y: centerY })
    }
  }, [activeMarker, boxOG, boxOD, bridgeL, bridgeR])

  const getImageDisplayRect = useCallback(() => {
    if (!containerRef.current || !imageSize) return null
    const r = containerRef.current.getBoundingClientRect()
    const cAspect = r.width / r.height
    const iAspect = imageSize.width / imageSize.height
    if (iAspect > cAspect) {
      const h = r.width / iAspect
      return { left: 0, top: (r.height - h) / 2, width: r.width, height: h }
    }
    const w = r.height * iAspect
    return { left: (r.width - w) / 2, top: 0, width: w, height: r.height }
  }, [imageSize])

  const toImageCoords = useCallback((clientX, clientY) => {
    if (!containerRef.current || !imageSize) return null
    const dr = getImageDisplayRect()
    if (!dr) return null
    const containerRect = containerRef.current.getBoundingClientRect()
    const rx = clientX - containerRect.left - dr.left
    const ry = clientY - containerRect.top - dr.top
    const cx = Math.max(0, Math.min(dr.width, rx))
    const cy = Math.max(0, Math.min(dr.height, ry))
    return { x: (cx / dr.width) * imageSize.width, y: (cy / dr.height) * imageSize.height }
  }, [imageSize, getImageDisplayRect])

  const getDefaultBoxSize = useCallback(() => {
    const scale = calibration?.scalePxToMm
    if (scale && scale > 0) return { width: Math.round(45 / scale), height: Math.round(35 / scale) }
    return { width: 72, height: 56 }
  }, [calibration])

  const handlePointerMove = useCallback((e) => {
    if (!containerRef.current) return
    const r = containerRef.current.getBoundingClientRect()
    setLoupePos({ x: e.clientX - r.left, y: e.clientY - r.top })
  }, [])

  const handlePointerLeave = useCallback(() => setLoupePos(null), [])

  const handleClick = useCallback((e) => {
    const coords = toImageCoords(e.clientX, e.clientY)
    if (!coords) return
    const pt = { x: Math.round(coords.x), y: Math.round(coords.y) }
    switch (activeMarker) {
      case 'bridgeL': setBridgeL(pt); break
      case 'bridgeR': setBridgeR(pt); break
      case 'left': setLeftEye(pt); break
      case 'right': setRightEye(pt); break
      case 'boxOG': {
        if (boxOG) break
        const def = getDefaultBoxSize()
        if (bridgeL) {
          setBoxOG({ x: bridgeL.x - def.width / 2, y: bridgeL.y, width: def.width, height: def.height })
          setLeftEye({ x: bridgeL.x - def.width / 2, y: bridgeL.y })
        } else {
          setBoxOG({ x: pt.x, y: pt.y, width: def.width, height: def.height })
          setLeftEye({ x: pt.x, y: pt.y })
        }
        break
      }
      case 'boxOD': {
        if (boxOD) break
        if (!boxOG) {
          const def = getDefaultBoxSize()
          if (bridgeR) {
            setBoxOD({ x: bridgeR.x + def.width / 2, y: bridgeR.y, width: def.width, height: def.height })
            setRightEye({ x: bridgeR.x + def.width / 2, y: bridgeR.y })
          } else {
            setBoxOD({ x: pt.x, y: pt.y, width: def.width, height: def.height })
            setRightEye({ x: pt.x, y: pt.y })
          }
        }
        break
      }
    }
  }, [activeMarker, toImageCoords, boxOG, boxOD, bridgeL, bridgeR, getDefaultBoxSize])

  const undo = () => {
    switch (activeMarker) {
      case 'bridgeL': if (bridgeL) setBridgeL(null); break
      case 'bridgeR': if (bridgeR) setBridgeR(null); break
      case 'left': if (leftEye) setLeftEye(null); break
      case 'right': if (rightEye) setRightEye(null); break
      case 'boxOG': if (boxOG) setBoxOG(null); break
      case 'boxOD': if (boxOD) setBoxOD(null); break
    }
  }

  const zoomIn = () => setLoupeZoom(z => Math.min(6, z + 1))
  const zoomOut = () => setLoupeZoom(z => Math.max(2, z - 1))

  // --- Calculs ---
  const result = (() => {
    if (!imageSize) return null
    const scale = calibration?.scalePxToMm || (140 / (imageSize.width * 0.65))
    const confiance = calibration?.confidence || 'moyenne'
    const pontOk = bridgeL && bridgeR
    const pupilsOk = !!(leftEye && rightEye)

    let pdBinoc = null, pdOG = null, pdOD = null
    if (pupilsOk) {
      pdBinoc = Math.round(Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y) * scale * 10) / 10
    }
    if (pontOk && pupilsOk) {
      const bc = { x: (bridgeL.x + bridgeR.x) / 2, y: (bridgeL.y + bridgeR.y) / 2 }
      pdOG = Math.round(Math.hypot(leftEye.x - bc.x, leftEye.y - bc.y) * scale * 10) / 10
      pdOD = Math.round(Math.hypot(rightEye.x - bc.x, rightEye.y - bc.y) * scale * 10) / 10
    } else if (pdBinoc) {
      pdOG = Math.round((pdBinoc / 2) * 10) / 10
      pdOD = Math.round((pdBinoc / 2) * 10) / 10
    }

    let pontMm = null
    if (pontOk) {
      pontMm = Math.round(Math.hypot(bridgeR.x - bridgeL.x, bridgeR.y - bridgeL.y) * scale * 10) / 10
    }

    const boxOGOk = boxOG && boxOG.width > 0 && boxOG.height > 0
    const boxODOk = boxOD && boxOD.width > 0 && boxOD.height > 0
    const frameOk = boxOGOk || boxODOk

    let largeurG = null, largeurD = null
    let hauteurCalibre = null
    let hauteurMontageOG = null, hauteurMontageOD = null

    if (boxOGOk) {
      largeurG = Math.round(boxOG.width * scale * 10) / 10
      if (leftEye) {
        const bottomY = boxOG.y + boxOG.height / 2
        hauteurMontageOG = Math.round(Math.abs(bottomY - leftEye.y) * scale * 10) / 10
      }
    }
    if (boxODOk) {
      largeurD = Math.round(boxOD.width * scale * 10) / 10
      if (rightEye) {
        const bottomY = boxOD.y + boxOD.height / 2
        hauteurMontageOD = Math.round(Math.abs(bottomY - rightEye.y) * scale * 10) / 10
      }
    }
    if (boxOGOk && boxODOk) {
      hauteurCalibre = Math.round(((boxOG.height + boxOD.height) / 2) * scale * 10) / 10
    } else if (boxOGOk) {
      hauteurCalibre = Math.round(boxOG.height * scale * 10) / 10
    } else if (boxODOk) {
      hauteurCalibre = Math.round(boxOD.height * scale * 10) / 10
    }

    return {
      pd: pdBinoc || 0,
      pdMonoculaireGauche: pdOG ?? 0,
      pdMonoculaireDroit: pdOD ?? 0,
      pont: pontMm,
      pontOk, pupilsOk, frameOk,
      largeurG, largeurD, hauteurCalibre, hauteurMontageOG, hauteurMontageOD,
      confiance,
      methode: calibration ? 'calibration_monture_reference' : 'marquage_manuel',
    }
  })()

  const confirm = () => {
    if (result) onConfirm({
      ...result,
      pdBinoculaire: result.pd,
      pontPlace: result.pontOk,
      calibration: calibration ? { scalePxToMm: Math.round(calibration.scalePxToMm * 1000) / 1000, variation: calibration.scaleVariation } : undefined,
    })
  }

  const SZ = 24
  const SZ_BRIDGE = 18
  const BRIDGE_COLOR = '#22c55e'
  const BOX_COLOR = '#8b5cf6'

  const renderCrossMarker = (pos, color, label, isActive, markerId, sz = SZ) => {
    if (!pos || !imageSize) return null
    const l = (pos.x / imageSize.width) * 100
    const t = (pos.y / imageSize.height) * 100
    const half = sz / 2
    const gap = 5 // gap in crosshair center
    const arm = half - 2
    return (
      <div className="absolute transform -translate-x-1/2 -translate-y-1/2 transition-all duration-150"
        style={{
          left: `${l}%`, top: `${t}%`,
          filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.5))',
          zIndex: 15,
          animation: isActive ? 'pulse-smarker 1.5s ease-in-out infinite' : 'none',
        }}
        onClick={(e) => { e.stopPropagation(); setActiveMarker(markerId) }}>
        <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
          {/* Outer glow ring */}
          <circle cx={half} cy={half} r={half - 1.5}
            fill="none" stroke={isActive ? '#fff' : color}
            strokeWidth={isActive ? 2.5 : 1.5}
            opacity={isActive ? 1 : 0.6}
          />
          {/* Dotted ring for inactive */}
          {!isActive && (
            <circle cx={half} cy={half} r={half - 3}
              fill="none" stroke={color} strokeWidth="1"
              strokeDasharray="2 3" opacity="0.3"
            />
          )}
          {/* Crosshair with gap */}
          <line x1={gap} y1={half} x2={half - gap} y2={half}
            stroke={color} strokeWidth="2" strokeLinecap="round" />
          <line x1={half + gap} y1={half} x2={sz - gap} y2={half}
            stroke={color} strokeWidth="2" strokeLinecap="round" />
          <line x1={half} y1={gap} x2={half} y2={half - gap}
            stroke={color} strokeWidth="2" strokeLinecap="round" />
          <line x1={half} y1={half + gap} x2={half} y2={sz - gap}
            stroke={color} strokeWidth="2" strokeLinecap="round" />
          {/* Center dot */}
          <circle cx={half} cy={half} r={2.5} fill={color} opacity={isActive ? 1 : 0.7} />
          {/* Inner glow when active */}
          {isActive && (
            <circle cx={half} cy={half} r={5} fill={color} opacity="0.2" />
          )}
        </svg>
        <div className="absolute -bottom-[18px] left-1/2 -translate-x-1/2 text-[10px] font-semibold whitespace-nowrap px-1.5 py-0.5 rounded"
          style={{
            color: '#fff',
            background: `${color}cc`,
            border: '1px solid rgba(255,255,255,0.2)',
            backdropFilter: 'blur(4px)',
            boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
          }}>{label}</div>
      </div>
    )
  }

  const renderBridgeBar = (pos, color, label, isActive, markerId) => {
    if (!pos || !imageSize) return null
    const l = (pos.x / imageSize.width) * 100
    const t = (pos.y / imageSize.height) * 100
    return (
      <div className="absolute transform -translate-x-1/2 -translate-y-1/2 transition-all duration-150"
        style={{
          left: `${l}%`, top: `${t}%`,
          filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.5))',
          zIndex: 15,
          animation: isActive ? 'pulse-smarker 1.5s ease-in-out infinite' : 'none',
        }}
        onClick={(e) => { e.stopPropagation(); setActiveMarker(markerId) }}>
        <svg width={SZ_BRIDGE} height={SZ_BRIDGE * 1.6} viewBox={`0 0 ${SZ_BRIDGE} ${SZ_BRIDGE * 1.6}`}>
          <defs>
            <linearGradient id={`bg-${markerId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={isActive ? '#fff' : color} stopOpacity="0.3" />
              <stop offset="50%" stopColor={color} stopOpacity="0.15" />
              <stop offset="100%" stopColor={isActive ? '#fff' : color} stopOpacity="0.3" />
            </linearGradient>
          </defs>
          {/* Pill-shaped body */}
          <rect x={SZ_BRIDGE * 0.22} y="2" width={SZ_BRIDGE * 0.56} height={SZ_BRIDGE * 1.6 - 4} rx={SZ_BRIDGE * 0.28}
            fill={`url(#bg-${markerId})`}
            stroke={isActive ? '#fff' : color}
            strokeWidth={isActive ? 2 : 1.5}
            opacity={isActive ? 1 : 0.7}
          />
          {/* Center line */}
          <line x1={SZ_BRIDGE / 2} y1={SZ_BRIDGE * 0.35} x2={SZ_BRIDGE / 2} y2={SZ_BRIDGE * 1.25}
            stroke={color} strokeWidth="2" strokeLinecap="round" opacity={isActive ? 1 : 0.5} />
          {/* Bottom dot */}
          <circle cx={SZ_BRIDGE / 2} cy={SZ_BRIDGE * 1.5 - 2} r="2" fill={color} opacity={isActive ? 1 : 0.4} />
        </svg>
        <div className="absolute -bottom-[18px] left-1/2 -translate-x-1/2 text-[10px] font-semibold whitespace-nowrap px-1.5 py-0.5 rounded"
          style={{
            color: '#fff',
            background: `${color}cc`,
            border: '1px solid rgba(255,255,255,0.2)',
            backdropFilter: 'blur(4px)',
            boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
          }}>{label}</div>
      </div>
    )
  }

  const btnStyle = (marker, accentColor) => ({
    background: activeMarker === marker ? `${accentColor}20` : 'var(--color-border)',
    color: activeMarker === marker ? accentColor : 'var(--color-text-dim)',
    border: activeMarker === marker ? `1.5px solid ${accentColor}` : '1.5px solid transparent',
  })

  const hasAnyMarker = leftEye || rightEye || bridgeL || bridgeR || boxOG || boxOD

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
      </div>

      {/* Zoom controls */}
      <div className="flex items-center justify-center gap-2">
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Loupe :</span>
        <button onClick={zoomOut} disabled={loupeZoom <= 2}
          className="flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold transition-opacity disabled:opacity-30"
          style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
          <ZoomOut size={14} />
        </button>
        <span className="text-xs font-medium min-w-[36px] text-center" style={{ color: 'var(--color-text-muted)' }}>
          ×{loupeZoom}
        </span>
        <button onClick={zoomIn} disabled={loupeZoom >= 6}
          className="flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold transition-opacity disabled:opacity-30"
          style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
          <ZoomIn size={14} />
        </button>
      </div>

      {/* Calibration info row */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        <span className="self-center text-[10px] font-medium" style={{ color: 'var(--color-gold)' }}>Calibrage :</span>
        <span className="self-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {calibration ? '✓ 3 repères placés' : 'Non fait'}
        </span>
      </div>

      {/* Pont buttons */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        <span className="self-center text-[10px] font-medium" style={{ color: BRIDGE_COLOR }}>Pont :</span>
        <button onClick={() => setActiveMarker('bridgeL')}
          className="flex-1 min-w-[55px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('bridgeL', BRIDGE_COLOR)}>
          <span className="w-2 h-3 rounded-sm inline-block" style={{ background: bridgeL ? BRIDGE_COLOR : 'var(--color-text-dim)' }} />
          Pont G{bridgeL ? ' ✓' : ''}
        </button>
        <button onClick={() => setActiveMarker('bridgeR')}
          className="flex-1 min-w-[55px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('bridgeR', BRIDGE_COLOR)}>
          <span className="w-2 h-3 rounded-sm inline-block" style={{ background: bridgeR ? BRIDGE_COLOR : 'var(--color-text-dim)' }} />
          Pont D{bridgeR ? ' ✓' : ''}
        </button>
      </div>

      {/* OG row */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        <span className="self-center text-[10px] font-medium" style={{ color: BOX_COLOR }}>Verre OG :</span>
        <button onClick={() => setActiveMarker('boxOG')}
          className="flex-1 min-w-[70px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('boxOG', BOX_COLOR)}>
          <span style={{ color: boxOG ? BOX_COLOR : 'var(--color-text-dim)' }}>▣</span>
          Box OG{boxOG ? ' ✓' : ''}
        </button>
        <button onClick={() => setActiveMarker('left')}
          className="flex-1 min-w-[55px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('left', '#3b82f6')}>
          <span className="w-3 h-3 rounded-full inline-block" style={{ background: leftEye ? '#3b82f6' : 'var(--color-text-dim)' }} />
          Pupille OG{leftEye ? ' ✓' : ''}
        </button>
        {boxOG && !boxOD && (
          <button onClick={() => setActiveMarker('boxOD')}
            className="flex-1 min-w-[60px] py-2 rounded-xl text-xs font-medium transition-all"
            style={{ background: 'var(--color-border)', color: BOX_COLOR }}>
            → Dupliquer OD
          </button>
        )}
        <span className="self-center text-[9px]" style={{ color: 'var(--color-text-dim)' }}>
          {activeMarker === 'boxOG' ? (boxOG ? '→ Ajustez' : '→ Tapez le verre') :
           activeMarker === 'left' ? (leftEye ? '→ Ok' : '→ Tapez la pupille') : ''}
        </span>
      </div>

      {/* OD row */}
      {boxOG && (
        <div className="flex items-stretch gap-1.5 flex-wrap">
          <span className="self-center text-[10px] font-medium" style={{ color: BOX_COLOR }}>Verre OD :</span>
          <button onClick={() => setActiveMarker('boxOD')}
            className="flex-1 min-w-[70px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
            style={btnStyle('boxOD', BOX_COLOR)}>
            <span style={{ color: boxOD ? BOX_COLOR : 'var(--color-text-dim)' }}>▣</span>
            Box OD{boxOD ? ' ✓' : ''}
          </button>
          <button onClick={() => setActiveMarker('right')}
            className="flex-1 min-w-[55px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
            style={btnStyle('right', 'var(--color-gold)')}>
            <span className="w-3 h-3 rounded-full inline-block" style={{ background: rightEye ? 'var(--color-gold)' : 'var(--color-text-dim)' }} />
            Pupille OD{rightEye ? ' ✓' : ''}
          </button>
          <button onClick={undo} disabled={!hasAnyMarker}
            className="px-3 py-2 rounded-xl text-xs font-medium transition-opacity disabled:opacity-30 flex items-center gap-1"
            style={{ background: 'var(--color-red-bg)', color: 'var(--color-red)' }}>
            <RotateCcw size={12} /> Annuler
          </button>
          <span className="self-center text-[9px]" style={{ color: 'var(--color-text-dim)' }}>
            {activeMarker === 'boxOD' ? (boxOD ? '→ Ajustez' : '→ Auto depuis OG') :
             activeMarker === 'right' ? (rightEye ? '→ Ok' : '→ Tapez') : ''}
          </span>
        </div>
      )}

      {/* Solo undo */}
      {!boxOG && (
        <div className="flex gap-1.5">
          <button onClick={undo} disabled={!hasAnyMarker}
            className="px-3 py-2 rounded-xl text-xs font-medium transition-opacity disabled:opacity-30 flex items-center gap-1"
            style={{ background: 'var(--color-red-bg)', color: 'var(--color-red)' }}>
            <RotateCcw size={12} /> Annuler
          </button>
        </div>
      )}

      {/* Image */}
      <div ref={containerRef}
        className="relative rounded-2xl border overflow-hidden select-none cursor-crosshair"
        style={{ background: '#08080a', borderColor: 'var(--color-border)', aspectRatio: imageSize ? `${imageSize.width}/${imageSize.height}` : '4/3' }}
        onClick={handleClick} onPointerMove={handlePointerMove} onPointerLeave={handlePointerLeave}>
        {imageUrl && <img src={imageUrl} alt="Centrage" className="w-full h-full block object-contain" draggable={false} />}

        <BoxingRect rect={boxOG} imageSize={imageSize} toImageCoords={toImageCoords}
          onChange={setBoxOG} active={activeMarker === 'boxOG'} color={BOX_COLOR} label="Verre OG" containerRef={containerRef} />
        <BoxingRect rect={boxOD} imageSize={imageSize} toImageCoords={toImageCoords}
          onChange={setBoxOD} active={activeMarker === 'boxOD'} color={BOX_COLOR} label="Verre OD" containerRef={containerRef} />

        {/* Vertical pupillary lines */}
        {boxOG && leftEye && imageSize && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 13 }}>
            <line x1={`${(leftEye.x / imageSize.width) * 100}%`}
              y1={`${((boxOG.y - boxOG.height / 2) / imageSize.height) * 100}%`}
              x2={`${(leftEye.x / imageSize.width) * 100}%`}
              y2={`${((boxOG.y + boxOG.height / 2) / imageSize.height) * 100}%`}
              stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="5 3" opacity="0.7" />
            <line x1={`${((leftEye.x - 6) / imageSize.width) * 100}%`}
              y1={`${(leftEye.y / imageSize.height) * 100}%`}
              x2={`${((leftEye.x + 6) / imageSize.width) * 100}%`}
              y2={`${(leftEye.y / imageSize.height) * 100}%`}
              stroke="#f59e0b" strokeWidth="2" opacity="0.8" />
          </svg>
        )}
        {boxOD && rightEye && imageSize && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 13 }}>
            <line x1={`${(rightEye.x / imageSize.width) * 100}%`}
              y1={`${((boxOD.y - boxOD.height / 2) / imageSize.height) * 100}%`}
              x2={`${(rightEye.x / imageSize.width) * 100}%`}
              y2={`${((boxOD.y + boxOD.height / 2) / imageSize.height) * 100}%`}
              stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="5 3" opacity="0.7" />
            <line x1={`${((rightEye.x - 6) / imageSize.width) * 100}%`}
              y1={`${(rightEye.y / imageSize.height) * 100}%`}
              x2={`${((rightEye.x + 6) / imageSize.width) * 100}%`}
              y2={`${(rightEye.y / imageSize.height) * 100}%`}
              stroke="#f59e0b" strokeWidth="2" opacity="0.8" />
          </svg>
        )}

        {bridgeL && renderBridgeBar(bridgeL, BRIDGE_COLOR, 'Pont G', activeMarker === 'bridgeL', 'bridgeL')}
        {bridgeR && renderBridgeBar(bridgeR, BRIDGE_COLOR, 'Pont D', activeMarker === 'bridgeR', 'bridgeR')}
        {leftEye && renderCrossMarker(leftEye, '#3b82f6', 'OG', activeMarker === 'left', 'left')}
        {rightEye && renderCrossMarker(rightEye, 'var(--color-gold)', 'OD', activeMarker === 'right', 'right')}

        {bridgeL && bridgeR && imageSize && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 10 }}>
            <line x1={`${(bridgeL.x / imageSize.width) * 100}%`} y1={`${(bridgeL.y / imageSize.height) * 100}%`}
              x2={`${(bridgeR.x / imageSize.width) * 100}%`} y2={`${(bridgeR.y / imageSize.height) * 100}%`}
              stroke={BRIDGE_COLOR} strokeWidth="3" opacity="0.5" />
          </svg>
        )}

        <Loupe imageUrl={imageUrl} pos={loupePos} zoom={loupeZoom} size={140} />

        <div className="absolute bottom-3 left-0 right-0 text-center pointer-events-none" style={{ zIndex: 50 }}>
          <span className="inline-block px-3 py-1.5 rounded-full text-xs"
            style={{ background: 'rgba(0,0,0,0.7)', color: '#ccc', border: '1px solid rgba(255,255,255,0.1)' }}>
            {result?.pupilsOk && result?.pontOk && (boxOG || boxOD) ? 'Tous les repères placés · Validez'
              : `Placez : ${
                activeMarker === 'bridgeL' ? 'Pont G' : activeMarker === 'bridgeR' ? 'Pont D'
                : activeMarker === 'left' ? 'Pupille OG' : activeMarker === 'right' ? 'Pupille OD'
                : activeMarker === 'boxOG' ? 'Box OG' : activeMarker === 'boxOD' ? 'Box OD' : ''}`}
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
                {result.frameOk ? `${result.largeurG ?? '—'}/${result.largeurD ?? '—'}` : '—'}
              </div>
            </div>
          </div>

          {/* H. Montage */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="text-center py-1.5 rounded-lg" style={{ background: result.hauteurMontageOG != null ? 'var(--color-purple-bg)' : 'var(--color-bg)' }}>
              <div className="text-[9px] uppercase" style={{ color: 'var(--color-text-muted)' }}>H. Montage OG</div>
              <div className="text-sm font-bold" style={{ color: result.hauteurMontageOG != null ? 'var(--color-purple)' : 'var(--color-text-dim)' }}>
                {result.hauteurMontageOG != null ? `${result.hauteurMontageOG} mm` : '—'}
              </div>
            </div>
            <div className="text-center py-1.5 rounded-lg" style={{ background: result.hauteurMontageOD != null ? 'var(--color-purple-bg)' : 'var(--color-bg)' }}>
              <div className="text-[9px] uppercase" style={{ color: 'var(--color-text-muted)' }}>H. Montage OD</div>
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
        <button onClick={confirm} disabled={!result?.pupilsOk}
          className="flex items-center justify-center gap-1.5 flex-1 py-3 rounded-full font-medium text-sm text-white transition-all hover:opacity-90 disabled:opacity-40"
          style={{ background: 'var(--color-gold)' }}>
          <Check size={16} /> Valider la mesure
        </button>
      </div>

      {result?.pupilsOk && (!result?.pontOk || !result?.frameOk) && (
        <div className="text-center">
          <p className="text-xs" style={{ color: 'var(--color-gold)' }}>
            {!result.pontOk ? '💡 Placez Pont G+D pour DP mono réelle. ' : ''}
            {!result.frameOk ? '💡 Placez les rectangles boxing pour le calibre.' : ''}
          </p>
        </div>
      )}
    </div>
  )
}

function c(l) {
  const xs = l.map(p => p.x), ys = l.map(p => p.y)
  return { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length }
}

function getBridgeHalfGapPx(calibration, imageSize) {
  const scale = calibration?.scalePxToMm
  if (scale && scale > 0) return Math.round(5 / scale)
  if (imageSize) return Math.round(imageSize.width * 0.012)
  return 8
}
