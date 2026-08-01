import { useState, useRef, useEffect, useCallback } from 'react'
import { RotateCcw, Check, SkipForward, AlertTriangle, Loader2, Settings2, Camera } from 'lucide-react'
import { analyzeCalibration } from './services/api'

export default function CalibrationOverlay({ imageUrl, onCalibrated, onSkip, onRetake, initialPoints }) {
  const [points, setPoints] = useState([])
  const [imageSize, setImageSize] = useState(null)
  const [debugInfo, setDebugInfo] = useState(null)
  const [markerSpacing, setMarkerSpacing] = useState(50)
  const [showSpacingInput, setShowSpacingInput] = useState(false)
  const [autoDetecting, setAutoDetecting] = useState(true)
  const [autoFailed, setAutoFailed] = useState(false)
  const backendScaleRef = useRef(null)  // échelle du backend, prioritaire
  const cancelAutoRef = useRef(false)
  const containerRef = useRef(null)
  const imageRef = useRef(null)

  // Rectangle réellement affiché à l'écran — source unique pour les coordonnées
  const getImageDisplayRect = useCallback(() => {
    const imgRect = imageRef.current?.getBoundingClientRect()
    if (!imgRect || !containerRef.current) return null
    const cRect = containerRef.current.getBoundingClientRect()
    return {
      left: imgRect.left - cRect.left,
      top: imgRect.top - cRect.top,
      width: imgRect.width,
      height: imgRect.height,
    }
  }, [])

  const toImageCoords = useCallback((clientX, clientY) => {
    const rect = getImageDisplayRect()
    if (!rect || !imageSize) return null
    const x = Math.max(0, Math.min(rect.width, clientX - containerRef.current.getBoundingClientRect().left - rect.left))
    const y = Math.max(0, Math.min(rect.height, clientY - containerRef.current.getBoundingClientRect().top - rect.top))
    return { x: (x / rect.width) * imageSize.width, y: (y / rect.height) * imageSize.height }
  }, [imageSize, getImageDisplayRect])

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
    // TOUJOURS appeler l'API backend
    setAutoDetecting(true)
    setAutoFailed(false)
    cancelAutoRef.current = false

    ;(async () => {
      await new Promise(r => setTimeout(r, 200))
      if (cancelAutoRef.current) { setAutoDetecting(false); setAutoFailed(true); return }

      // 1) Backend API /api/analyze-calibration (HoughCircles + checkerboard)
      try {
        const resp = await fetch(imageUrl)
        const blob = await resp.blob()
        if (cancelAutoRef.current) { setAutoDetecting(false); setAutoFailed(true); return }
        const apiResult = await analyzeCalibration(blob)
        if (!cancelAutoRef.current && apiResult.markers && apiResult.markers.length === 3) {
          setPoints(apiResult.markers)
          setAutoDetecting(false)
          // Utiliser l'échelle calculée par le backend — plus de recalcul frontal
          const scaleInfo = {
            scalePxToMm: apiResult.scale_mm_per_px,
            pixelDist1: Math.round(apiResult.spacing_px),
            pixelDist2: Math.round(apiResult.spacing_px),
            scaleVariation: 0,
            headRotation: 0,
            poseAssessment: 'Automatique (backend)',
          }
          setDebugInfo({ ...scaleInfo, backendConfidence: apiResult.detection_confidence })
          backendScaleRef.current = scaleInfo  // stocker pour confirmCalibration
          return
        }
      } catch (e) {
        console.error('Calibration API échouée:', e.message)
        if (!cancelAutoRef.current) {
          setAutoDetecting(false)
          setAutoFailed(true)
          setDebugInfo({ error: 'API indisponible — vérifiez la connexion au serveur' })
        }
        return
      }
    })()
  }, [imageUrl, markerSpacing])

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

  const resetPoints = () => {
    setPoints([])
    setDebugInfo(null)
    setAutoFailed(false)
    backendScaleRef.current = null
  }

  const confirmCalibration = () => {
    if (points.length === 3) {
      // Priorité à l'échelle backend si dispo (évite le recalcul)
      const scaleData = backendScaleRef.current || calculateScale(points, markerSpacing)
      onCalibrated(scaleData)
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
        className="relative select-none overflow-hidden mx-auto"
        style={{
          cursor: allPlaced ? 'default' : 'crosshair',
          touchAction: 'none',
          maxHeight: '60vh',
          width: 'fit-content',
          fontSize: 0,
          lineHeight: 0,
        }}
        onPointerDown={handleContainerPointerDown}
      >
        <img ref={imageRef} src={imageUrl} alt="Calibrage" className="block"
          style={{ maxHeight: '60vh', width: 'auto', touchAction: 'none' }}
          draggable={false} />

        {/* Markers + connection lines — overlay div calé sur l'image (comme PupilMarker) */}
        {imageSize && getImageDisplayRect() && (() => {
          const dr = getImageDisplayRect()
          return (
            <div style={{ position: 'absolute', left: dr.left, top: dr.top, width: dr.width, height: dr.height, zIndex: 10 }}>
              {points.map((p, i) => {
                const leftPct = (p.x / imageSize.width) * 100
                const topPct = (p.y / imageSize.height) * 100
                const isDragging = dragTarget?.index === i
                return (
                  <div key={i} className="absolute transform -translate-x-1/2 -translate-y-1/2 transition-none"
                    style={{ left: `${leftPct}%`, top: `${topPct}%`, zIndex: isDragging ? 30 : 10, cursor: 'grab' }}
                    data-markerid={i}>
                    <svg width="22" height="22" viewBox="0 0 22 22" className="mx-auto block"
                      style={{ filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.5))' }}>
                      <circle cx="11" cy="11" r="9" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
                      <line x1="2" y1="11" x2="20" y2="11" stroke={isDragging ? '#ff2dd0' : 'rgba(255,255,255,0.6)'} strokeWidth="1.5" />
                      <line x1="11" y1="2" x2="11" y2="20" stroke={isDragging ? '#ff2dd0' : 'rgba(255,255,255,0.6)'} strokeWidth="1.5" />
                      <circle cx="11" cy="11" r={isDragging ? 3 : 2} fill={isDragging ? '#ff2dd0' : 'rgba(255,255,255,0.8)'} />
                    </svg>
                    <div className="text-[10px] text-center mt-1 font-bold tracking-wider px-1 rounded-sm"
                      style={{
                        color: isDragging ? '#ff2dd0' : 'rgba(255,255,255,0.8)',
                        background: 'rgba(10, 10, 12, 0.6)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                      }}>
                      {['Gauche','Centre','Droite'][i]}
                    </div>
                  </div>
                )
              })}

              {/* Connection lines */}
              {points.length >= 2 && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 5 }}>
                  <line x1={`${(points[0].x / imageSize.width) * 100}%`}
                    y1={`${(points[0].y / imageSize.height) * 100}%`}
                    x2={`${(points[1].x / imageSize.width) * 100}%`}
                    y2={`${(points[1].y / imageSize.height) * 100}%`}
                    stroke="rgba(255, 255, 255, 0.7)" strokeWidth="1.2" strokeDasharray="3 3" />
                  {points.length === 3 && (
                    <line x1={`${(points[1].x / imageSize.width) * 100}%`}
                      y1={`${(points[1].y / imageSize.height) * 100}%`}
                      x2={`${(points[2].x / imageSize.width) * 100}%`}
                      y2={`${(points[2].y / imageSize.height) * 100}%`}
                      stroke="rgba(255, 255, 255, 0.7)" strokeWidth="1.2" strokeDasharray="3 3" />
                  )}
                </svg>
              )}
            </div>
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

      </div>

      {/* Spacing + reset + debug */}
      <div className="px-4 py-2 flex justify-between items-center border-t" style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex items-center gap-3">
          <button onClick={() => setShowSpacingInput(!showSpacingInput)}
            className="flex items-center gap-1 text-xs transition-all hover:opacity-80" style={{ color: 'var(--color-gold)' }}>
            <Settings2 size={12} /> Écart : {markerSpacing} mm
          </button>
          {debugInfo && allPlaced && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{
              background: debugInfo.headRotation > 10 ? 'var(--color-red-bg)' : 'var(--color-green-bg)',
              color: debugInfo.headRotation > 10 ? 'var(--color-red)' : 'var(--color-green)',
              border: '1px solid',
              borderColor: debugInfo.headRotation > 10 ? 'var(--color-red)' : 'var(--color-green)',
            }}>
              {Math.round(debugInfo.scalePxToMm * 1000) / 1000} mm/px
            </span>
          )}
        </div>
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
            <span style={{ color: 'var(--color-text-muted)' }}>Distance (Gauche ➔ Centre) :</span>
            <span style={{ color: 'var(--color-text-dim)' }}>{debugInfo.pixelDist1} px</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--color-text-muted)' }}>Distance (Centre ➔ Droite) :</span>
            <span style={{ color: 'var(--color-text-dim)' }}>{debugInfo.pixelDist2} px</span>
          </div>
          <div className="flex justify-between font-medium">
            <span style={{ color: 'var(--color-text-muted)' }}>Échelle active :</span>
            <span style={{ color: 'var(--color-gold)' }}>1 px = {Math.round(debugInfo.scalePxToMm * 1000) / 1000} mm</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--color-text-muted)' }}>Alignement tête (Symétrie) :</span>
            <span style={{ color: debugInfo.headRotation > 10 ? 'var(--color-red)' : 'var(--color-green)' }}>
              {debugInfo.poseAssessment}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function calculateScale(points, spacing = 50) {
  // Calcul de la distance géométrique directe entre le repère Gauche (0) et le repère Droite (2)
  const dTotal = Math.hypot(points[2].x - points[0].x, points[2].y - points[0].y)
  
  // L'échelle absolue en mm/pixel calculée sur les 100mm totaux du clip (spacing * 2)
  const totalSpacingMm = spacing * 2
  const finalScale = totalSpacingMm / dTotal

  // Pour l'analyse de symétrie (rotation ou inclinaison de la tête du patient)
  const d1 = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) // gauche -> centre
  const d2 = Math.hypot(points[2].x - points[1].x, points[2].y - points[1].y) // centre -> droite
  const ratio = Math.abs(d1 - d2) / ((d1 + d2) / 2)
  const headRotationAngle = Math.round(ratio * 100)

  // Qualité de centrage basée sur la symétrie
  let poseAssessment = 'Excellente (Centrage 100%)'
  if (headRotationAngle > 4) poseAssessment = 'Bonne (Légère inclinaison ' + headRotationAngle + '%)'
  if (headRotationAngle > 10) poseAssessment = 'Correction requise (Tête tournée à ' + headRotationAngle + '%)'

  return {
    scalePxToMm: finalScale,
    pixelDist1: Math.round(d1),
    pixelDist2: Math.round(d2),
    scaleVariation: 0, // Option chirurgicale demandée : 0% d'erreur sur l'échelle de mesure
    headRotation: headRotationAngle,
    poseAssessment: poseAssessment,
    totalSpanMm: totalSpacingMm
  }
}
