import { useState, useRef, useEffect, useCallback } from 'react'
import { ArrowLeft, RotateCcw, Check, SkipForward, AlertTriangle, Loader2, Settings2, Camera } from 'lucide-react'
import Loupe from './Loupe'
import { detectCalibrationMarkers } from './detectMarkers'

export default function CalibrationOverlay({ imageUrl, onCalibrated, onSkip, onRetake }) {
  const [points, setPoints] = useState([])
  const [imageSize, setImageSize] = useState(null)
  const [loupePos, setLoupePos] = useState(null)
  const [debugInfo, setDebugInfo] = useState(null)
  const [markerSpacing, setMarkerSpacing] = useState(50)
  const [showSpacingInput, setShowSpacingInput] = useState(false)
  const [autoDetecting, setAutoDetecting] = useState(true)
  const [autoFailed, setAutoFailed] = useState(false)
  const [editingIndex, setEditingIndex] = useState(null)
  const cancelAutoRef = useRef(false)
  const containerRef = useRef(null)

  useEffect(() => {
    const img = new Image()
    img.src = imageUrl
    img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
  }, [imageUrl])

  const cancelAutoDetect = useCallback(() => {
    cancelAutoRef.current = true
    setAutoDetecting(false)
    setAutoFailed(true)
  }, [])

  useEffect(() => {
    if (!imageUrl) return
    let cancelled = false
    setAutoDetecting(true)
    setAutoFailed(false)
    cancelAutoRef.current = false

    ;(async () => {
      await new Promise(r => setTimeout(r, 200))
      if (cancelAutoRef.current) { setAutoDetecting(false); setAutoFailed(true); return }

      // Timeout réduit à 15s
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 15000))
      const found = await Promise.race([detectCalibrationMarkers(imageUrl), timeoutPromise])
      if (cancelled || cancelAutoRef.current) { setAutoDetecting(false); setAutoFailed(true); return }

      setAutoDetecting(false)

      if (found && found.length === 3) {
        setPoints(found)
        const scale = calculateScale(found, markerSpacing)
        setDebugInfo(scale)
      } else {
        setAutoFailed(true)
      }
    })()

    return () => { cancelled = true }
  }, [imageUrl])

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

  const toImageCoords = (clientX, clientY) => {
    if (!containerRef.current || !imageSize) return null
    const dr = getImageDisplayRect()
    if (!dr) return null
    const containerRect = containerRef.current.getBoundingClientRect()
    const rx = clientX - containerRect.left - dr.left
    const ry = clientY - containerRect.top - dr.top
    const cx = Math.max(0, Math.min(dr.width, rx))
    const cy = Math.max(0, Math.min(dr.height, ry))
    return { x: (cx / dr.width) * imageSize.width, y: (cy / dr.height) * imageSize.height }
  }

  const handlePointerMove = (e) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setLoupePos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const handlePointerLeave = () => setLoupePos(null)

  const handleClick = (e) => {
    if (points.length >= 3 && editingIndex === null) return
    const coords = toImageCoords(e.clientX, e.clientY)
    if (!coords) return

    if (editingIndex !== null) {
      const newPoints = [...points]
      newPoints[editingIndex] = coords
      setPoints(newPoints)
      setEditingIndex(null)
      if (newPoints.length === 3) {
        setDebugInfo(calculateScale(newPoints, markerSpacing))
      }
      return
    }

    if (points.length < 3) {
      const newPoints = [...points, coords]
      setPoints(newPoints)
      if (newPoints.length === 3) {
        setDebugInfo(calculateScale(newPoints, markerSpacing))
      }
    }
  }

  const resetPoints = () => {
    setPoints([])
    setDebugInfo(null)
    setEditingIndex(null)
    setAutoFailed(false)
  }

  const startEdit = (index) => {
    setEditingIndex(index)
  }

  const confirmCalibration = () => {
    if (points.length === 3) {
      onCalibrated(calculateScale(points, markerSpacing))
    }
  }

  const getLabel = (i) => ['Gauche', 'Centre', 'Droite'][i] || ''

  const allPlaced = points.length === 3

  return (
    <div className="rounded-2xl border overflow-hidden animate-fade-in" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
      {/* Toolbar */}
      <div className="px-4 py-3 flex items-center justify-between border-b" style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex items-center gap-2">
          {allPlaced ? (
            <span className="text-xs" style={{ color: 'var(--color-green)' }}>
              ✓ 3 repères placés
            </span>
          ) : autoDetecting ? (
            <span className="text-xs" style={{ color: 'var(--color-gold)' }}>
              Analyse…
            </span>
          ) : (
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              ① Gauche → ② Centre → ③ Droite
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onRetake && (
            <button onClick={onRetake} className="flex items-center gap-1 text-xs transition-all hover:opacity-80" style={{ color: 'var(--color-red)' }}>
              <Camera size={12} /> Reprendre
            </button>
          )}
          <button onClick={onSkip} className="flex items-center gap-1 text-xs transition-all hover:opacity-80" style={{ color: 'var(--color-text-muted)' }}>
            <SkipForward size={12} /> Passer
          </button>
        </div>
      </div>

      {/* Auto-detection status */}
      {autoDetecting && (
        <div className="px-4 py-2.5 flex items-center gap-2.5" style={{ background: 'var(--color-gold-bg)', borderBottom: '1px solid var(--color-border)' }}>
          <Loader2 size={14} className="animate-spin-slow" style={{ color: 'var(--color-gold)', animation: 'spin 1s linear infinite' }} />
          <span className="text-xs flex-1" style={{ color: 'var(--color-gold-light)' }}>Recherche automatique des 3 repères…</span>
          <button
            onClick={cancelAutoDetect}
            className="px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition-all hover:opacity-90"
            style={{ background: 'var(--color-red)', color: '#fff' }}
          >
            Annuler
          </button>
        </div>
      )}
      {autoFailed && (
        <div className="px-4 py-2.5 flex items-center gap-2" style={{ background: 'var(--color-red-bg)', borderBottom: '1px solid var(--color-border)' }}>
          <AlertTriangle size={14} style={{ color: 'var(--color-red)' }} />
          <p className="text-xs" style={{ color: 'var(--color-red)' }}>
            Détection infructueuse — Placez les 3 repères manuellement avec la loupe
          </p>
        </div>
      )}

      {/* Image + annotations */}
      <div
        ref={containerRef}
        className="relative cursor-crosshair select-none"
        onClick={handleClick}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        <img src={imageUrl} alt="Calibrage" className="w-full block" style={{ maxHeight: '60vh', objectFit: 'contain' }}
          draggable={false} />

        {/* Markers */}
        {imageSize && (() => {
          const dr = getImageDisplayRect()
          const cw = containerRef.current?.getBoundingClientRect()?.width || 1
          const ch = containerRef.current?.getBoundingClientRect()?.height || 1
          return points.map((p, i) => {
            const leftPct = dr ? ((dr.left + (p.x / imageSize.width) * dr.width) / cw) * 100 : (p.x / imageSize.width) * 100
            const topPct = dr ? ((dr.top + (p.y / imageSize.height) * dr.height) / ch) * 100 : (p.y / imageSize.height) * 100
            const isEditing = editingIndex === i
            return (
              <div key={i} className="absolute transform -translate-x-1/2 -translate-y-1/2 transition-all duration-100"
                style={{ left: `${leftPct}%`, top: `${topPct}%`, zIndex: isEditing ? 30 : 10, cursor: 'pointer' }}
                onClick={(e) => { e.stopPropagation(); startEdit(i) }}>
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all"
                  style={{
                    background: isEditing ? 'var(--color-red)' : 'var(--color-gold)',
                    color: isEditing ? '#fff' : 'var(--color-bg)',
                    boxShadow: isEditing
                      ? '0 0 0 4px rgba(204,68,68,0.4), 0 0 12px rgba(204,68,68,0.3)'
                      : '0 0 0 3px rgba(201,151,90,0.3)',
                    transform: isEditing ? 'scale(1.15)' : 'scale(1)',
                  }}>
                  {i + 1}
                </div>
                <div className="text-[10px] text-center mt-0.5 font-medium" style={{ color: 'var(--color-text-muted)' }}>
                  {isEditing ? '↕ Ajuster' : getLabel(i)}
                </div>
              </div>
            )
          })
        })()}

        {/* Connection lines */}
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
                stroke="var(--color-gold)" strokeWidth="2" strokeDasharray="4 2" />
              {points.length === 3 && (
                <line x1={`${lineX(points[1])}%`} y1={`${lineY(points[1])}%`}
                  x2={`${lineX(points[2])}%`} y2={`${lineY(points[2])}%`}
                  stroke="var(--color-gold)" strokeWidth="2" strokeDasharray="4 2" />
              )}
            </svg>
          )
        })()}

        {/* Guide hint */}
        {!allPlaced && points.length < 3 && (
          <div className="absolute bottom-3 left-0 right-0 text-center pointer-events-none" style={{ zIndex: 50 }}>
            <span className="inline-block px-3 py-1.5 rounded-full text-xs font-medium"
              style={{ background: 'rgba(0,0,0,0.7)', color: '#ccc', border: '1px solid rgba(255,255,255,0.1)' }}>
              {editingIndex !== null ? `Tapotez pour repositionner le repère ${editingIndex + 1}` :
               points.length === 0 ? '① Repère GAUCHE' :
               points.length === 1 ? '② Repère CENTRE' :
               '③ Repère DROITE'}
            </span>
          </div>
        )}

        {allPlaced && editingIndex === null && (
          <div className="absolute bottom-3 left-0 right-0 flex justify-center gap-2 pointer-events-none" style={{ zIndex: 50 }}>
            <span className="inline-block px-3 py-1.5 rounded-full text-xs font-medium pointer-events-auto"
              style={{ background: 'rgba(0,0,0,0.7)', color: '#ccc', border: '1px solid rgba(255,255,255,0.1)' }}>
              Tapotez ① ② ③ pour ajuster
            </span>
          </div>
        )}

        <Loupe imageUrl={imageUrl} pos={loupePos} zoom={3} size={140} />
      </div>

      {/* Spacing + reset */}
      <div className="px-4 py-2 flex justify-between items-center border-t" style={{ borderColor: 'var(--color-border)' }}>
        <button onClick={() => setShowSpacingInput(!showSpacingInput)}
          className="flex items-center gap-1 text-xs transition-all hover:opacity-80" style={{ color: 'var(--color-gold)' }}>
          <Settings2 size={12} /> Écart : {markerSpacing} mm
        </button>
        {points.length > 0 && (
          <button onClick={resetPoints} className="flex items-center gap-1 text-xs transition-all hover:opacity-80" style={{ color: 'var(--color-gold)' }}>
            <RotateCcw size={12} /> Recommencer
          </button>
        )}
      </div>

      {showSpacingInput && (
        <div className="px-4 py-2 flex items-center gap-2 border-t" style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }}>
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Écart entre repères :</span>
          <input type="number" value={markerSpacing} onChange={e => setMarkerSpacing(Number(e.target.value) || 50)}
            className="w-16 px-2 py-1 rounded text-xs text-center border"
            style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }} />
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>mm</span>
        </div>
      )}

      {/* Validation */}
      {allPlaced && (
        <div className="px-4 py-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <button
            onClick={confirmCalibration}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-full font-medium text-sm transition-all hover:opacity-90"
            style={{ background: 'var(--color-gold)', color: 'var(--color-bg)' }}
          >
            <Check size={16} /> Valider la calibration ({markerSpacing}mm × 2)
          </button>
        </div>
      )}

      {/* Debug info */}
      {debugInfo && (
        <div className="px-4 py-3 space-y-1 text-xs border-t" style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }}>
          <div className="flex justify-between">
            <span style={{ color: 'var(--color-text-muted)' }}>Distance (gauche→centre) :</span>
            <span style={{ color: 'var(--color-text-dim)' }}>{debugInfo.pixelDist1} px</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--color-text-muted)' }}>Distance (centre→droite) :</span>
            <span style={{ color: 'var(--color-text-dim)' }}>{debugInfo.pixelDist2} px</span>
          </div>
          <div className="flex justify-between font-medium">
            <span style={{ color: 'var(--color-text-muted)' }}>Échelle :</span>
            <span style={{ color: 'var(--color-gold)' }}>1 px = {Math.round(debugInfo.scalePxToMm * 1000) / 1000} mm</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--color-text-muted)' }}>Variation :</span>
            <span style={{ color: debugInfo.scaleVariation > 20 ? 'var(--color-red)' : 'var(--color-green)' }}>{debugInfo.scaleVariation}%</span>
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
