import { useState, useRef, useEffect, useCallback } from 'react'
import Loupe from './Loupe'
import BoxingRect from './BoxingRect'

/**
 * Centrage complet : pont, pupilles + boxing (calibre par rectangle).
 * 6 repères : Pont G, Pont D, OG, OD + Box OG, Box OD.
 */
export default function PupilMarker({ imageUrl, calibration, onConfirm, onBack }) {
  const [imageSize, setImageSize] = useState(null)
  // Pupilles
  const [leftEye, setLeftEye] = useState(null)
  const [rightEye, setRightEye] = useState(null)
  // Pont
  const [bridgeL, setBridgeL] = useState(null)
  const [bridgeR, setBridgeR] = useState(null)
  // Boxing rectangles (lens) — { x, y, width, height } in image px (x,y = center)
  const [boxOG, setBoxOG] = useState(null)
  const [boxOD, setBoxOD] = useState(null)

  const [activeMarker, setActiveMarker] = useState('bridgeL')
  const [loupeZoom, setLoupeZoom] = useState(3)
  const [loupePos, setLoupePos] = useState(null)
  const containerRef = useRef(null)

  // Load image
  useEffect(() => {
    const img = new Image(); img.src = imageUrl
    img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
  }, [imageUrl])

  // Auto-detect
  useEffect(() => {
    if (!imageSize) return
    let cancelled = false
    ;(async () => {
      try {
        const img = new Image(); img.src = imageUrl
        await new Promise(r => { img.onload = r })
        if (typeof window.FaceDetector !== 'undefined') {
          const faces = await new window.FaceDetector({ maxDetectedFaces: 1, fastMode: false }).detect(await createImageBitmap(img))
          if (!cancelled && faces.length > 0) {
            const f = faces[0]
            if (f.landmarks) {
              const eyes = f.landmarks.filter(l => l.type === 'eye')
              const nose = f.landmarks.filter(l => l.type === 'nose')
              if (eyes.length >= 2) {
                setLeftEye(c(eyes[0].locations))
                setRightEye(c(eyes[1].locations))
              }
              if (nose.length > 0) {
                const nc = c(nose[0].locations)
                setBridgeL({ x: nc.x - 8, y: nc.y })
                setBridgeR({ x: nc.x + 8, y: nc.y })
              }
              return
            }
            const b = f.boundingBox?.box || f.boundingBox
            const cx = b.x + b.width * 0.50
            const cy = b.y + b.height * 0.62
            setLeftEye({ x: b.x + b.width * 0.29, y: b.y + b.height * 0.42 })
            setRightEye({ x: b.x + b.width * 0.71, y: b.y + b.height * 0.42 })
            setBridgeL({ x: cx - 10, y: cy })
            setBridgeR({ x: cx + 10, y: cy })
            return
          }
        }
        try {
          const fa = await import('face-api.js')
          await Promise.all([fa.nets.tinyFaceDetector.loadFromUri('https://justadudewhohacks.github.io/face-api.js/models'),
            fa.nets.faceLandmarks68Net.loadFromUri('https://justadudewhohacks.github.io/face-api.js/models')])
          const d = await fa.detectSingleFace(img, new fa.TinyFaceDetectorOptions()).withFaceLandmarks()
          if (!cancelled && d?.landmarks) {
            setLeftEye(c(d.landmarks.getLeftEye()))
            setRightEye(c(d.landmarks.getRightEye()))
            const nose = d.landmarks.getNose()
            if (nose && nose.length >= 3) {
              const nc = c(nose.slice(0, 4))
              setBridgeL({ x: nc.x - 8, y: nc.y })
              setBridgeR({ x: nc.x + 8, y: nc.y })
            }
            return
          }
        } catch (_) {}
        if (!cancelled) {
          const mx = img.width / 2, my = img.height * 0.42, d = img.width * 0.12
          setLeftEye({ x: mx - d, y: my })
          setRightEye({ x: mx + d, y: my })
          setBridgeL({ x: mx - 10, y: my + d * 0.9 })
          setBridgeR({ x: mx + 10, y: my + d * 0.9 })
        }
      } catch (_) {}
    })()
    return () => { cancelled = true }
  }, [imageUrl, imageSize])

  // --- Coordinate mapping ---
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

  // Compute default box size based on calibration or fallback
  const getDefaultBoxSize = useCallback(() => {
    const scale = calibration?.scalePxToMm
    if (scale && scale > 0) {
      // ~50mm wide, ~35mm tall in pixels
      return { width: Math.round(50 / scale), height: Math.round(35 / scale) }
    }
    // Fallback: reasonable default in pixels
    return { width: 80, height: 60 }
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
        if (!boxOG) {
          const def = getDefaultBoxSize()
          setBoxOG({ x: pt.x, y: pt.y, width: def.width, height: def.height })
        }
        break
      }
      case 'boxOD': {
        if (!boxOD) {
          const def = getDefaultBoxSize()
          setBoxOD({ x: pt.x, y: pt.y, width: def.width, height: def.height })
        }
        break
      }
    }
  }, [activeMarker, toImageCoords, boxOG, boxOD, getDefaultBoxSize])

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

  // --- Calculations ---
  const result = (() => {
    if (!imageSize) return null
    const scale = calibration?.scalePxToMm || (140 / (imageSize.width * 0.65))
    const confiance = calibration?.confidence || 'moyenne'
    const pontOk = bridgeL && bridgeR
    const pupilsOk = !!(leftEye && rightEye)

    // Pupillary distances
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

    // Bridge
    let pontMm = null
    if (pontOk) {
      pontMm = Math.round(Math.hypot(bridgeR.x - bridgeL.x, bridgeR.y - bridgeL.y) * scale * 10) / 10
    }

    // Frame / lens dimensions from boxing rectangles
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

  const SZ = 20
  const BRIDGE_COLOR = '#22c55e'
  const BOX_COLOR = '#8b5cf6' // purple for boxing rectangles

  // --- Render helpers ---
  const renderCrossMarker = (pos, color, label, isActive, sz = SZ) => {
    if (!pos || !imageSize) return null
    const l = (pos.x / imageSize.width) * 100; const t = (pos.y / imageSize.height) * 100
    return (
      <div className="absolute transform -translate-x-1/2 -translate-y-1/2 transition-all duration-150"
        style={{ left: `${l}%`, top: `${t}%`, filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.7))', zIndex: 15 }}>
        <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
          <circle cx={sz/2} cy={sz/2} r={sz/2 - 1} fill="none" stroke={isActive ? '#fff' : color}
            strokeWidth={isActive ? '2.5' : '1.5'} opacity={isActive ? 1 : 0.7} />
          <line x1={3} y1={sz/2} x2={sz-3} y2={sz/2} stroke={color} strokeWidth="2" />
          <line x1={sz/2} y1={3} x2={sz/2} y2={sz-3} stroke={color} strokeWidth="2" />
          {isActive && <circle cx={sz/2} cy={sz/2} r={4} fill={color} opacity="0.5" />}
        </svg>
        <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[9px] font-bold whitespace-nowrap" style={{ color }}>{label}</div>
      </div>
    )
  }

  const renderBridgeBar = (pos, color, label, isActive) => {
    if (!pos || !imageSize) return null
    const l = (pos.x / imageSize.width) * 100; const t = (pos.y / imageSize.height) * 100
    return (
      <div className="absolute transform -translate-x-1/2 -translate-y-1/2 transition-all duration-150"
        style={{ left: `${l}%`, top: `${t}%`, filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.7))', zIndex: 15 }}>
        <svg width={14} height={28} viewBox="0 0 14 28">
          <rect x="3" y="2" width="8" height="24" rx="2" fill="none" stroke={isActive ? '#fff' : color}
            strokeWidth={isActive ? '2.5' : '1.5'} opacity={isActive ? 1 : 0.7} />
          <line x1="7" y1="7" x2="7" y2="21" stroke={color} strokeWidth="2" opacity={isActive ? 1 : 0.6} />
        </svg>
        <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[9px] font-bold whitespace-nowrap" style={{ color }}>{label}</div>
      </div>
    )
  }

  const btnStyle = (marker, color, borderColor) => ({
    background: activeMarker === marker ? color + '15' : '#f5f5f5',
    color: activeMarker === marker ? color : '#999',
    border: activeMarker === marker ? `2px solid ${borderColor}` : '2px solid transparent',
  })

  const hasAnyMarker = leftEye || rightEye || bridgeL || bridgeR || boxOG || boxOD

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-1" style={{ color: '#2d2d2d', fontFamily: 'Georgia, serif' }}>Centrage & Monture</h2>
        <p className="text-sm" style={{ color: '#888' }}>Boxing (calibre) · Pont · Pupilles</p>
      </div>

      {/* Zoom */}
      <div className="flex items-center justify-center gap-2">
        <span className="text-xs" style={{ color: '#999' }}>Loupe :</span>
        <button onClick={zoomOut} disabled={loupeZoom <= 2} className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-opacity disabled:opacity-30"
          style={{ background: '#f0ede7', color: '#666' }}>−</button>
        <span className="text-xs font-medium min-w-[36px] text-center" style={{ color: '#888' }}>×{loupeZoom}</span>
        <button onClick={zoomIn} disabled={loupeZoom >= 6} className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-opacity disabled:opacity-30"
          style={{ background: '#f0ede7', color: '#666' }}>+</button>
      </div>

      {/* Marker buttons — Row 1: Boxing (calibre) — à placer en premier */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        <span className="self-center text-[10px] px-0.5 font-medium" style={{ color: BOX_COLOR }}>Boxing :</span>
        <button onClick={() => setActiveMarker('boxOG')}
          className="flex-1 min-w-[70px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('boxOG', BOX_COLOR, BOX_COLOR)}>
          <span className="text-[10px]" style={{ color: boxOG ? BOX_COLOR : '#ddd' }}>▣</span>
          Verre OG{boxOG ? ' ✓' : ''}
        </button>
        <button onClick={() => setActiveMarker('boxOD')}
          className="flex-1 min-w-[70px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('boxOD', BOX_COLOR, BOX_COLOR)}>
          <span className="text-[10px]" style={{ color: boxOD ? BOX_COLOR : '#ddd' }}>▣</span>
          Verre OD{boxOD ? ' ✓' : ''}
        </button>
        <span className="self-center text-[9px] px-0.5" style={{ color: '#999' }}>
          {!boxOG && activeMarker === 'boxOG' ? '→ Tapez sur le verre' :
           !boxOD && activeMarker === 'boxOD' ? '→ Tapez sur le verre' :
           activeMarker === 'boxOG' || activeMarker === 'boxOD' ? '→ Ajustez les poignées' : ''}
        </span>
      </div>

      {/* Marker buttons — Row 2: Pont + Pupilles */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        <button onClick={() => setActiveMarker('bridgeL')}
          className="flex-1 min-w-[55px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('bridgeL', BRIDGE_COLOR, BRIDGE_COLOR)}>
          <span className="w-2 h-3 rounded-sm inline-block" style={{ background: bridgeL ? BRIDGE_COLOR : '#ddd' }} />
          Pont G{bridgeL ? ' ✓' : ''}
        </button>
        <button onClick={() => setActiveMarker('bridgeR')}
          className="flex-1 min-w-[55px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('bridgeR', BRIDGE_COLOR, BRIDGE_COLOR)}>
          <span className="w-2 h-3 rounded-sm inline-block" style={{ background: bridgeR ? BRIDGE_COLOR : '#ddd' }} />
          Pont D{bridgeR ? ' ✓' : ''}
        </button>
        <span className="self-center text-xs px-0.5" style={{ color: '#ccc' }}>|</span>
        <button onClick={() => setActiveMarker('left')}
          className="flex-1 min-w-[55px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('left', '#3b82f6', '#3b82f6')}>
          <span className="w-3 h-3 rounded-full inline-block" style={{ background: leftEye ? '#3b82f6' : '#ddd' }} />
          OG{leftEye ? ' ✓' : ''}
        </button>
        <button onClick={() => setActiveMarker('right')}
          className="flex-1 min-w-[55px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('right', '#c9975a', '#c9975a')}>
          <span className="w-3 h-3 rounded-full inline-block" style={{ background: rightEye ? '#c9975a' : '#ddd' }} />
          OD{rightEye ? ' ✓' : ''}
        </button>
        <button onClick={undo} disabled={!hasAnyMarker}
          className="px-3 py-2 rounded-xl text-xs font-medium transition-opacity disabled:opacity-30"
          style={{ background: '#f5e5e5', color: '#c44' }}>↩</button>
      </div>

      {/* Image */}
      <div
        ref={containerRef}
        className="relative rounded-2xl shadow-lg overflow-hidden select-none cursor-crosshair"
        style={{ background: '#1a1a1a', aspectRatio: imageSize ? `${imageSize.width}/${imageSize.height}` : '4/3' }}
        onClick={handleClick}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        {imageUrl && <img src={imageUrl} alt="Centrage" className="w-full h-full block object-contain" draggable={false} />}

        {/* Boxing rectangles */}
        <BoxingRect
          rect={boxOG}
          imageSize={imageSize}
          toImageCoords={toImageCoords}
          onChange={setBoxOG}
          active={activeMarker === 'boxOG'}
          color={BOX_COLOR}
          label="Verre OG"
          containerRef={containerRef}
        />
        <BoxingRect
          rect={boxOD}
          imageSize={imageSize}
          toImageCoords={toImageCoords}
          onChange={setBoxOD}
          active={activeMarker === 'boxOD'}
          color={BOX_COLOR}
          label="Verre OD"
          containerRef={containerRef}
        />

        {/* Vertical pupillary lines — through OG/OD within boxing rectangles */}
        {boxOG && leftEye && imageSize && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 13 }}>
            <line
              x1={`${(leftEye.x / imageSize.width) * 100}%`}
              y1={`${((boxOG.y - boxOG.height / 2) / imageSize.height) * 100}%`}
              x2={`${(leftEye.x / imageSize.width) * 100}%`}
              y2={`${((boxOG.y + boxOG.height / 2) / imageSize.height) * 100}%`}
              stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="5 3" opacity="0.7"
            />
            {/* Horizontal tick at pupil level */}
            <line
              x1={`${((leftEye.x - 6) / imageSize.width) * 100}%`}
              y1={`${(leftEye.y / imageSize.height) * 100}%`}
              x2={`${((leftEye.x + 6) / imageSize.width) * 100}%`}
              y2={`${(leftEye.y / imageSize.height) * 100}%`}
              stroke="#f59e0b" strokeWidth="2" opacity="0.8"
            />
            {/* Height annotation */}
            <text x={`${((leftEye.x + 10) / imageSize.width) * 100}%`}
              y={`${(((boxOG.y + boxOG.height / 2 + leftEye.y) / 2) / imageSize.height) * 100}%`}
              fill="#f59e0b" fontSize="10" fontWeight="bold" opacity="0.9"
              style={{ textShadow: '0 0 3px rgba(0,0,0,0.6)' }}>
              {result?.hauteurMontageOG != null ? `${result.hauteurMontageOG}` : ''}
            </text>
          </svg>
        )}
        {boxOD && rightEye && imageSize && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 13 }}>
            <line
              x1={`${(rightEye.x / imageSize.width) * 100}%`}
              y1={`${((boxOD.y - boxOD.height / 2) / imageSize.height) * 100}%`}
              x2={`${(rightEye.x / imageSize.width) * 100}%`}
              y2={`${((boxOD.y + boxOD.height / 2) / imageSize.height) * 100}%`}
              stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="5 3" opacity="0.7"
            />
            {/* Horizontal tick at pupil level */}
            <line
              x1={`${((rightEye.x - 6) / imageSize.width) * 100}%`}
              y1={`${(rightEye.y / imageSize.height) * 100}%`}
              x2={`${((rightEye.x + 6) / imageSize.width) * 100}%`}
              y2={`${(rightEye.y / imageSize.height) * 100}%`}
              stroke="#f59e0b" strokeWidth="2" opacity="0.8"
            />
            {/* Height annotation */}
            <text x={`${((rightEye.x - 26) / imageSize.width) * 100}%`}
              y={`${(((boxOD.y + boxOD.height / 2 + rightEye.y) / 2) / imageSize.height) * 100}%`}
              fill="#f59e0b" fontSize="10" fontWeight="bold" opacity="0.9" textAnchor="end"
              style={{ textShadow: '0 0 3px rgba(0,0,0,0.6)' }}>
              {result?.hauteurMontageOD != null ? `${result.hauteurMontageOD}` : ''}
            </text>
          </svg>
        )}

        {/* Bridge */}
        {bridgeL && renderBridgeBar(bridgeL, BRIDGE_COLOR, 'Pont G', activeMarker === 'bridgeL')}
        {bridgeR && renderBridgeBar(bridgeR, BRIDGE_COLOR, 'Pont D', activeMarker === 'bridgeR')}

        {/* Eyes */}
        {leftEye && renderCrossMarker(leftEye, '#3b82f6', 'OG', activeMarker === 'left')}
        {rightEye && renderCrossMarker(rightEye, '#c9975a', 'OD', activeMarker === 'right')}

        {/* Bridge bar */}
        {bridgeL && bridgeR && imageSize && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 10 }}>
            <line x1={`${(bridgeL.x / imageSize.width) * 100}%`} y1={`${(bridgeL.y / imageSize.height) * 100}%`}
              x2={`${(bridgeR.x / imageSize.width) * 100}%`} y2={`${(bridgeR.y / imageSize.height) * 100}%`}
              stroke={BRIDGE_COLOR} strokeWidth="3" opacity="0.5" />
          </svg>
        )}

        <Loupe imageUrl={imageUrl} pos={loupePos} zoom={loupeZoom} size={140} />

        <div className="absolute bottom-3 left-0 right-0 text-center pointer-events-none" style={{ zIndex: 50 }}>
          <span className="inline-block px-3 py-1 rounded-full text-xs" style={{ background: 'rgba(0,0,0,0.55)', color: '#fff' }}>
            {result?.pupilsOk && result?.pontOk && (boxOG || boxOD) ? 'Tous les repères placés · Validez'
              : `Placez : ${
                activeMarker === 'bridgeL' ? 'Pont G' : activeMarker === 'bridgeR' ? 'Pont D'
                : activeMarker === 'left' ? 'OG' : activeMarker === 'right' ? 'OD'
                : activeMarker === 'boxOG' ? 'Box OG (tapez le verre)' : activeMarker === 'boxOD' ? 'Box OD (tapez le verre)'
                : ''}`}
          </span>
        </div>
      </div>

      {/* Live measurements */}
      {result && (
        <div className="rounded-xl p-4 space-y-3 shadow-sm" style={{ background: '#fff' }}>
          {/* DP */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs" style={{ color: '#999' }}>DP Binoculaire</div>
              <div className="text-2xl font-bold" style={{ color: '#2d2d2d' }}>{result.pd} <span className="text-sm" style={{ color: '#aaa' }}>mm</span></div>
            </div>
            <div className="text-right text-xs space-y-0.5" style={{ color: '#888' }}>
              <div>OG : {result.pdMonoculaireGauche} mm</div>
              <div>OD : {result.pdMonoculaireDroit} mm</div>
            </div>
          </div>

          {/* Pont + Calibre (boxing) */}
          <div className="grid grid-cols-3 gap-2 pt-2 border-t" style={{ borderColor: '#f0ede7' }}>
            <div className="text-center py-1.5 rounded-lg" style={{ background: result.pontOk ? '#f0fdf4' : '#faf9f6' }}>
              <div className="text-[9px] uppercase" style={{ color: '#999' }}>Pont</div>
              <div className="text-sm font-bold" style={{ color: result.pontOk ? '#166534' : '#ccc' }}>
                {result.pontOk ? `${result.pont} mm` : '—'}
              </div>
            </div>
            <div className="text-center py-1.5 rounded-lg" style={{ background: result.frameOk ? '#f5f3ff' : '#faf9f6' }}>
              <div className="text-[9px] uppercase" style={{ color: '#999' }}>H. Calibre</div>
              <div className="text-sm font-bold" style={{ color: result.frameOk ? '#7c3aed' : '#ccc' }}>
                {result.frameOk ? `${result.hauteurCalibre} mm` : '—'}
              </div>
            </div>
            <div className="text-center py-1.5 rounded-lg" style={{ background: result.frameOk ? '#f5f3ff' : '#faf9f6' }}>
              <div className="text-[9px] uppercase" style={{ color: '#999' }}>L. Calibre</div>
              <div className="text-sm font-bold" style={{ color: result.frameOk ? '#7c3aed' : '#ccc' }}>
                {result.frameOk
                  ? `${result.largeurG ?? '—'}/${result.largeurD ?? '—'}`
                  : '—'}
              </div>
            </div>
          </div>

          {/* Hauteur montage */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="text-center py-1.5 rounded-lg" style={{ background: result.hauteurMontageOG != null ? '#f5f3ff' : '#faf9f6' }}>
              <div className="text-[9px] uppercase" style={{ color: '#999' }}>H. Montage OG</div>
              <div className="text-sm font-bold" style={{ color: result.hauteurMontageOG != null ? '#7c3aed' : '#ccc' }}>
                {result.hauteurMontageOG != null ? `${result.hauteurMontageOG} mm` : '—'}
              </div>
            </div>
            <div className="text-center py-1.5 rounded-lg" style={{ background: result.hauteurMontageOD != null ? '#f5f3ff' : '#faf9f6' }}>
              <div className="text-[9px] uppercase" style={{ color: '#999' }}>H. Montage OD</div>
              <div className="text-sm font-bold" style={{ color: result.hauteurMontageOD != null ? '#7c3aed' : '#ccc' }}>
                {result.hauteurMontageOD != null ? `${result.hauteurMontageOD} mm` : '—'}
              </div>
            </div>
          </div>

          {/* Boxing debug info */}
          {boxOG && (
            <div className="text-[10px] text-center" style={{ color: '#aaa' }}>
              Box OG : {Math.round(boxOG.width)}×{Math.round(boxOG.height)} px
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        {onBack && <button onClick={onBack} className="flex-1 py-3 rounded-full font-medium text-sm transition-all hover:opacity-80"
          style={{ background: '#f0ede7', color: '#666' }}>← Retour</button>}
        <button onClick={confirm} disabled={!result?.pupilsOk}
          className="flex-1 py-3 rounded-full font-medium text-sm text-white transition-all hover:opacity-90 disabled:opacity-40"
          style={{ background: '#c9975a' }}>✓ Valider la mesure</button>
      </div>

      {result?.pupilsOk && (!result?.pontOk || !result?.frameOk) && (
        <div className="text-center">
          <p className="text-xs" style={{ color: '#c9975a' }}>
            💡 {!result.pontOk ? 'Placez Pont G+D pour DP mono réelle. ' : ''}
            {!result.frameOk ? 'Placez les rectangles boxing OG et/ou OD pour le calibre.' : ''}
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
