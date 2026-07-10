import { useState, useRef, useEffect, useCallback } from 'react'
import { RotateCcw, Check, SkipForward, AlertTriangle, Loader2, Settings2, Camera } from 'lucide-react'
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
  const cancelAutoRef = useRef(false)
  const containerRef = useRef(null)

  // ── Drag state for calibration markers ──
  const [dragTarget, setDragTarget] = useState(null) // { index, startClient, startPos }
  const pointsRef = useRef([])

  // Keep ref in sync
  useEffect(() => { pointsRef.current = points }, [points])

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
  }, [imageUrl, markerSpacing])

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

  const handlePointerMove = (e) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setLoupePos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  // ── Drag markers via data-markerid ──
  const handleContainerPointerDown = (e) => {
    // Walk up DOM to find a calibration marker
    let target = e.target
    while (target && target !== containerRef.current) {
      if (target.dataset?.markerid !== undefined) {
        const idx = parseInt(target.dataset.markerid, 10)
        const p = pointsRef.current[idx]
        if (!p) return
        e.preventDefault()
        setDragTarget({ index: idx, startClient: { x: e.clientX, y: e.clientY }, startPos: { ...p } })
        return
      }
      target = target.parentElement
    }

    // Tap outside markers → no-op (désactive tout)
    // But if less than 3 markers and not dragging, create new marker
    const cp = pointsRef.current
    if (cp.length >= 3) return // all 3 placed → tap outside does nothing
    const coords = toImageCoords(e.clientX, e.clientY)
    if (!coords) return
    const newPoints = [...cp, coords]
    setPoints(newPoints)
    if (newPoints.length === 3) {
      setDebugInfo(calculateScale(newPoints, markerSpacing))
    }
  }

  // Window-level drag listeners
  useEffect(() => {
    if (!dragTarget) return

    const onMove = (e) => {
      // Loupe
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        setLoupePos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      }
      const startImg = toImageCoords(dragTarget.startClient.x, dragTarget.startClient.y)
      const currImg = toImageCoords(e.clientX, e.clientY)
      if (!startImg || !currImg) return
      const dx = currImg.x - startImg.x
      const dy = currImg.y - startImg.y
      const newPos = { x: dragTarget.startPos.x + dx, y: dragTarget.startPos.y + dy }
      const newPoints = [...pointsRef.current]
      newPoints[dragTarget.index] = newPos
      setPoints(newPoints)
    }

    const onUp = () => {
      setDragTarget(null)
      // Recalc scale if we have 3
      if (pointsRef.current.length === 3) {
        setDebugInfo(calculateScale(pointsRef.current, markerSpacing))
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragTarget, toImageCoords, markerSpacing])

  const handlePointerLeave = () => setLoupePos(null)

  const resetPoints = () => {
    setPoints([])
    setDebugInfo(null)
    setAutoFailed(false)
  }

  const confirmCalibration = () => {
    if (points.length === 3) {
      onCalibrated(calculateScale(points, markerSpacing))
    }
  }

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
              ① Gauche · ② Centre · ③ Droite
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

      {/* Image + markers */}
      <div
        ref={containerRef}
        className="relative select-none"
        style={{ cursor: allPlaced ? 'default' : 'crosshair', touchAction: 'none' }}
        onPointerDown={handleContainerPointerDown}
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
            const isDragging = dragTarget?.index === i
            return (
              <div key={i} className="absolute transform -translate-x-1/2 -translate-y-1/2 transition-none"
                style={{ left: `${leftPct}%`, top: `${topPct}%`, zIndex: isDragging ? 30 : 10, cursor: 'grab' }}
                data-markerid={i}>
                {/* Marqueur : cercle vide + point central */}
                <svg width="22" height="22" viewBox="0 0 22 22" className="mx-auto block">
                  <circle cx="11" cy="11" r="9"
                    fill="none"
                    stroke={isDragging ? '#fff' : 'var(--color-gold)'}
                    strokeWidth={isDragging ? 2.5 : 2}
                    opacity={isDragging ? 1 : 0.8}
                    style={{ filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.6))' }} />
                  <circle cx="11" cy="11" r="2"
                    fill={isDragging ? 'var(--color-red)' : 'var(--color-gold)'}
                    opacity={isDragging ? 1 : 0.9} />
                </svg>
                <div className="text-[9px] text-center mt-0.5 font-medium" style={{ color: 'var(--color-gold)' }}>
                  {['Gauche','Centre','Droite'][i]}
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
        {!allPlaced && (
          <div className="absolute bottom-3 left-0 right-0 text-center pointer-events-none" style={{ zIndex: 50 }}>
            <span className="inline-block px-3 py-1.5 rounded-full text-xs font-medium"
              style={{ background: 'rgba(0,0,0,0.7)', color: '#ccc', border: '1px solid rgba(255,255,255,0.1)' }}>
              {points.length === 0 ? '① Repère GAUCHE' :
               points.length === 1 ? '② Repère CENTRE' :
               '③ Repère DROITE'}
            </span>
          </div>
        )}

        <Loupe imageUrl={imageUrl} pos={loupePos} zoom={3} size={140}
          displayRect={getImageDisplayRect()} imageSize={imageSize} />
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
