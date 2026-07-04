import { useState, useRef, useEffect } from 'react'
import Loupe from './Loupe'

/**
 * Calibration: tap 3 reference markers (50mm spacing) on the photo.
 * Uses magnifying glass (loupe) for pixel-perfect precision.
 */
export default function CalibrationOverlay({ imageUrl, onCalibrated, onSkip }) {
  const [points, setPoints] = useState([])   // [{x, y}, ...] in image pixels
  const [imageSize, setImageSize] = useState(null)
  const [loupePos, setLoupePos] = useState(null)
  const [debugInfo, setDebugInfo] = useState(null)
  const [markerSpacing, setMarkerSpacing] = useState(50) // mm between adjacent markers
  const [showSpacingInput, setShowSpacingInput] = useState(false)
  const containerRef = useRef(null)

  useEffect(() => {
    const img = new Image()
    img.src = imageUrl
    img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
  }, [imageUrl])

  // Get actual image display rect within container (accounts for object-fit:contain letterboxing)
  const getImageDisplayRect = () => {
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
  }

  // Convert screen coords to image pixel coords (compensates letterboxing)
  const toImageCoords = (clientX, clientY) => {
    if (!containerRef.current || !imageSize) return null
    const dr = getImageDisplayRect()
    if (!dr) return null
    const containerRect = containerRef.current.getBoundingClientRect()
    const rx = clientX - containerRect.left - dr.left
    const ry = clientY - containerRect.top - dr.top
    // Clamp within image bounds
    const cx = Math.max(0, Math.min(dr.width, rx))
    const cy = Math.max(0, Math.min(dr.height, ry))
    return {
      x: (cx / dr.width) * imageSize.width,
      y: (cy / dr.height) * imageSize.height,
    }
  }

  const handlePointerMove = (e) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setLoupePos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const handlePointerLeave = () => setLoupePos(null)

  const handleClick = (e) => {
    if (points.length >= 3) return
    const coords = toImageCoords(e.clientX, e.clientY)
    if (!coords) return
    const newPoints = [...points, coords]
    setPoints(newPoints)
    if (newPoints.length === 3) {
      const scale = calculateScale(newPoints, markerSpacing)
      setDebugInfo(scale)
      onCalibrated(scale)
    }
  }

  const resetPoints = () => setPoints([])

  const getLabel = (i) => ['Gauche', 'Centre', 'Droite'][i] || ''

  return (
    <div className="rounded-2xl overflow-hidden shadow-lg" style={{ background: '#fff' }}>
      <div className="px-4 py-3" style={{ background: '#f5f0e8' }}>
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold" style={{ color: '#2d2d2d' }}>Calibration — Monture de référence</h4>
            <p className="text-xs mt-0.5" style={{ color: '#888' }}>
              La loupe vous aide à viser · Touchez gauche → centre → droite
            </p>
          </div>
          <button onClick={onSkip} className="text-xs underline" style={{ color: '#999' }}>Passer</button>
        </div>
      </div>

      {/* Image + loupe */}
      <div
        ref={containerRef}
        className="relative cursor-crosshair select-none"
        onClick={handleClick}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        <img src={imageUrl} alt="Calibrage" className="w-full block" style={{ maxHeight: '60vh', objectFit: 'contain' }}
          draggable={false} />

        {/* Placed markers (compensated for letterboxing) */}
        {imageSize && (() => {
          const dr = getImageDisplayRect()
          const cw = containerRef.current?.getBoundingClientRect()?.width || 1
          const ch = containerRef.current?.getBoundingClientRect()?.height || 1
          return points.map((p, i) => {
            const leftPct = dr ? ((dr.left + (p.x / imageSize.width) * dr.width) / cw) * 100 : (p.x / imageSize.width) * 100
            const topPct = dr ? ((dr.top + (p.y / imageSize.height) * dr.height) / ch) * 100 : (p.y / imageSize.height) * 100
            return (
              <div key={i} className="absolute transform -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${leftPct}%`, top: `${topPct}%` }}>
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold"
                  style={{ background: '#c9975a', boxShadow: '0 0 0 3px rgba(201,151,90,0.3)' }}>
                  {i + 1}
                </div>
                <div className="text-[10px] text-center mt-0.5 font-medium" style={{ color: '#2d2d2d' }}>{getLabel(i)}</div>
              </div>
            )
          })
        })()}

        {/* Connection lines (compensated for letterboxing) */}
        {imageSize && points.length >= 2 && (() => {
          const dr = getImageDisplayRect()
          const cw = containerRef.current?.getBoundingClientRect()?.width || 1
          const ch = containerRef.current?.getBoundingClientRect()?.height || 1
          const lineX = (p) => dr ? ((dr.left + (p.x / imageSize.width) * dr.width) / cw) * 100 : (p.x / imageSize.width) * 100
          const lineY = (p) => dr ? ((dr.top + (p.y / imageSize.height) * dr.height) / ch) * 100 : (p.y / imageSize.height) * 100
          return (
            <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 5 }}>
              <line x1={`${lineX(points[0])}%`} y1={`${lineY(points[0])}%`}
                x2={`${lineX(points[1])}%`} y2={`${lineY(points[1])}%`}
                stroke="#c9975a" strokeWidth="2" strokeDasharray="4 2" />
              {points.length === 3 && (
                <line x1={`${lineX(points[1])}%`} y1={`${lineY(points[1])}%`}
                  x2={`${lineX(points[2])}%`} y2={`${lineY(points[2])}%`}
                  stroke="#c9975a" strokeWidth="2" strokeDasharray="4 2" />
              )}
            </svg>
          )
        })()}

        {/* Guide hint */}
        {points.length < 3 && (
          <div className="absolute bottom-3 left-0 right-0 text-center pointer-events-none" style={{ zIndex: 50 }}>
            <span className="inline-block px-3 py-1 rounded-full text-xs font-medium"
              style={{ background: 'rgba(0,0,0,0.6)', color: '#fff' }}>
              {points.length === 0 && '① Repère GAUCHE'}
              {points.length === 1 && '② Repère CENTRE'}
              {points.length === 2 && '③ Repère DROITE'}
            </span>
          </div>
        )}

        {/* Loupe */}
        <Loupe imageUrl={imageUrl} pos={loupePos} zoom={3} size={140} />
      </div>

      <div className="px-4 py-2 flex justify-between items-center">
        <button onClick={() => setShowSpacingInput(!showSpacingInput)} className="text-xs" style={{ color: '#c9975a' }}>
          ⚙ Écart repères : {markerSpacing} mm
        </button>
        {points.length > 0 && (
          <button onClick={resetPoints} className="text-xs" style={{ color: '#c9975a' }}>↺ Recommencer</button>
        )}
      </div>

      {/* Spacing input */}
      {showSpacingInput && (
        <div className="px-4 py-2 flex items-center gap-2" style={{ background: '#faf9f6' }}>
          <span className="text-xs" style={{ color: '#888' }}>Écart entre repères :</span>
          <input type="number" value={markerSpacing} onChange={e => setMarkerSpacing(Number(e.target.value) || 50)}
            className="w-16 px-2 py-1 rounded text-xs text-center border" style={{ borderColor: '#ddd' }} />
          <span className="text-xs" style={{ color: '#888' }}>mm</span>
        </div>
      )}

      {/* Debug info */}
      {debugInfo && (
        <div className="px-4 py-3 space-y-1 text-xs border-t" style={{ background: '#faf9f6', borderColor: '#e8e6e0' }}>
          <div className="flex justify-between">
            <span style={{ color: '#999' }}>Distance pixels (gauche→centre) :</span>
            <span style={{ color: '#666' }}>{debugInfo.pixelDist1} px</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: '#999' }}>Distance pixels (centre→droite) :</span>
            <span style={{ color: '#666' }}>{debugInfo.pixelDist2} px</span>
          </div>
          <div className="flex justify-between font-medium">
            <span style={{ color: '#999' }}>Échelle calculée :</span>
            <span style={{ color: '#c9975a' }}>1 px = {Math.round(debugInfo.scalePxToMm * 1000) / 1000} mm</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: '#999' }}>Variation :</span>
            <span style={{ color: debugInfo.scaleVariation > 20 ? '#c44' : '#2d7d2d' }}>{debugInfo.scaleVariation}%</span>
          </div>
        </div>
      )}
    </div>
  )
}

function calculateScale(points, spacing = 50) {
  const d1 = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)
  const d2 = Math.hypot(points[2].x - points[1].x, points[2].y - points[1].y)
  const s1 = spacing / d1; const s2 = spacing / d2
  const avg = (s1 + s2) / 2
  const variation = Math.abs(s1 - s2) / avg
  let conf = 'haute'; if (variation > 0.15) conf = 'moyenne'; if (variation > 0.30) conf = 'faible'
  return { scalePxToMm: avg, pixelDist1: Math.round(d1), pixelDist2: Math.round(d2), scaleVariation: Math.round(variation * 100), confidence: conf, totalSpanMm: spacing * 2 }
}
