import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronLeft, RotateCcw, Camera, Check } from 'lucide-react'
import BoxingRect from './BoxingRect'

export default function PupilMarker({ imageUrl, calibration, onConfirm, onBack, onRetake }) {
  const [imageSize, setImageSize] = useState(null)
  const [leftEye, setLeftEye] = useState(null)
  const [rightEye, setRightEye] = useState(null)
  const [bridge, setBridge] = useState(null) // Un seul repère central de pont (haut du nez)
  const [boxOG, setBoxOG] = useState(null)
  const [boxOD, setBoxOD] = useState(null)
  const [activeMarker, setActiveMarker] = useState('bridge')
    const [panelPos, setPanelPos] = useState(null) // null = use default
  const panelDragRef = useRef(null) // { startX, startY, baseX, baseY }
  const panelRef = useRef(null)
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
                setBridge({ x: nc.x, y: nc.y })
              }
              if (eyesFound) return
            }
            // Fallback bounding box proportions
            const b = f.boundingBox?.box || f.boundingBox
            const cx = b.x + b.width * 0.50, cy = b.y + b.height * 0.62
            setLeftEye({ x: b.x + b.width * 0.29, y: b.y + b.height * 0.42 })
            setRightEye({ x: b.x + b.width * 0.71, y: b.y + b.height * 0.42 })
            setBridge({ x: cx, y: cy })
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
              setBridge({ x: nc.x, y: nc.y })
            }
            return
          }
        } catch {}

        // 3) Proportion estimate
        if (!cancelled) {
          const mx = img.width / 2, my = img.height * 0.42, d = img.width * 0.12
          setLeftEye({ x: mx - d, y: my }); setRightEye({ x: mx + d, y: my })
          setBridge({ x: mx, y: my + d * 0.9 })
        }
      } catch {}
    })()
    return () => { cancelled = true }
  }, [imageUrl, imageSize, calibration])

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

  const getDefaultBoxSize = useCallback(() => {
    const scale = calibration?.scalePxToMm
    if (scale && scale > 0) return { width: Math.round(45 / scale), height: Math.round(35 / scale) }
    return { width: 72, height: 56 }
  }, [calibration])

  const undo = () => {
    switch (activeMarker) {
      case 'bridge': if (bridge) setBridge(null); break
      case 'left': if (leftEye) setLeftEye(null); break
      case 'right': if (rightEye) setRightEye(null); break
      case 'boxOG': if (boxOG) setBoxOG(null); break
      case 'boxOD': if (boxOD) setBoxOD(null); break
    }
  }

  // --- Calculs ---
  const result = (() => {
    if (!imageSize) return null
    const scale = calibration?.scalePxToMm || (140 / (imageSize.width * 0.65))
    const confiance = calibration?.confidence || 'moyenne'
    const pontOk = !!bridge
    const pupilsOk = !!(leftEye && rightEye)

    let pdBinoc = null, pdOG = null, pdOD = null
    if (pupilsOk) {
      pdBinoc = Math.round(Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y) * scale * 10) / 10
    }
    if (pontOk && pupilsOk) {
      // leftEye = côté gauche image = patient OD (œil droit), rightEye = côté droit image = patient OG (œil gauche)
      pdOD = Math.round(Math.hypot(leftEye.x - bridge.x, leftEye.y - bridge.y) * scale * 10) / 10
      pdOG = Math.round(Math.hypot(rightEye.x - bridge.x, rightEye.y - bridge.y) * scale * 10) / 10
    } else if (pdBinoc) {
      pdOG = Math.round((pdBinoc / 2) * 10) / 10
      pdOD = Math.round((pdBinoc / 2) * 10) / 10
    }

    const boxOGOk = boxOG && boxOG.width > 0 && boxOG.height > 0
    const boxODOk = boxOD && boxOD.width > 0 && boxOD.height > 0
    const frameOk = boxOGOk || boxODOk

    // Le Pont (EIV) se calcule sur le Boxing (Bord nasal OG - Bord nasal OD)
    let pontMm = null
    if (boxOGOk && boxODOk) {
      // boxOG = gauche image (verre OD), boxOD = droite image (verre OG)
      const nasalOD = boxOG.x + boxOG.width
      const nasalOG = boxOD.x
      const gapPx = Math.abs(nasalOG - nasalOD)
      pontMm = Math.round(gapPx * scale * 10) / 10
    }

    let largeurOG = null, largeurOD = null
    let hauteurCalibre = null
    let hauteurMontageOG = null, hauteurMontageOD = null

    if (boxOGOk) {
      largeurOD = Math.round(boxOG.width * scale * 10) / 10
      if (leftEye) {
        const bottomY = boxOG.y + boxOG.height / 2
        hauteurMontageOG = Math.round(Math.abs(bottomY - leftEye.y) * scale * 10) / 10
      }
    }
    if (boxODOk) {
      largeurOG = Math.round(boxOD.width * scale * 10) / 10
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
      largeurOG, largeurOD, hauteurCalibre, hauteurMontageOG, hauteurMontageOD,
      confiance,
      methode: calibration ? 'calibration_monture_reference' : 'marquage_manuel',
    }
  })()

  const confirm = async () => {
    if (!result) return
    onConfirm({
      ...result,
      pdBinoculaire: result.pd,
      pontPlace: result.pontOk,
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
    if (id === 'boxOG' && boxOG && !boxOD && !boxDuplicated.current) {
      const bridgeCenterX = WestCenterX(bridge, boxOG)
      const offset = boxOG.x - bridgeCenterX
      const mirrorX = bridgeCenterX - offset
      setBoxOD({ x: mirrorX, y: boxOG.y, width: boxOG.width, height: boxOG.height })
      boxDuplicated.current = true
    }
    if (id === 'boxOD' && boxOD && !boxOG && !boxDuplicated.current) {
      const bridgeCenterX = WestCenterX(bridge, boxOD)
      const offset = boxOD.x - bridgeCenterX
      const mirrorX = bridgeCenterX - offset
      setBoxOG({ x: mirrorX, y: boxOD.y, width: boxOD.width, height: boxOD.height })
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

  const WestCenterX = (bridgePt, fallbackBox) => {
    if (bridgePt) return bridgePt.x
    return fallbackBox.x
  }

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
    // Not on a marker → tap outside: place if not yet existing, otherwise no-op (pure drag)
    const coords = toImageCoords(e.clientX, e.clientY)
    if (!coords) return
    const pt = { x: Math.round(coords.x), y: Math.round(coords.y) }
    const am = activeMarkerRef.current
    // Si le marqueur actif est verrouillé, ignorer tout tap
    if (am && lockedRef.current.has(am)) return
    const b = currentPosRef.current.bridge

        // Tap repositionne le marqueur actif (même s'il existe déjà)
        if (am === 'bridge') { setBridge(pt); return }
        if (am === 'left')   { setLeftEye(pt); return }
        if (am === 'right')  { setRightEye(pt); return }
        if (am === 'boxOG' && !boxOG) {
          const def = getDefaultBoxSize()
          if (b) {
            setBoxOG({ x: b.x - def.width / 2, y: b.y, width: def.width, height: def.height })
          } else {
            setBoxOG({ x: pt.x, y: pt.y, width: def.width, height: def.height })
          }
          return
        }
        if (am === 'boxOD' && !boxOD) {
          if (!boxOG) {
            const def = getDefaultBoxSize()
            if (b) {
              setBoxOD({ x: b.x + def.width / 2, y: b.y, width: def.width, height: def.height })
            } else {
              setBoxOD({ x: pt.x, y: pt.y, width: def.width, height: def.height })
            }
          }
          return
        }
    // Already placed → tap outside does nothing
    return
  }, [toImageCoords, boxOG, boxOD, getDefaultBoxSize])

  // ── Simplified marker renderers — réticules purs directement tactiles ──
  const renderCrossMarkerSimple = (pos, color, label, isActive, markerId, sz = 22) => {
    if (!pos || !imageSize) return null
    const l = (pos.x / imageSize.width) * 100
    const t = (pos.y / imageSize.height) * 100
    const half = sz / 2
    const handleOffsetY = -75

    return (
    <div style={{
      position: 'absolute',
      left: `${l}%`, top: `${t}%`,
      zIndex: 15,
      pointerEvents: 'none',
    }}>
      {/* Réticule de précision — centré sur le point de mesure, non tactile */}
      <div style={{
        position: 'absolute',
        left: 0, top: 0,
        transform: 'translate(-50%, -50%)',
        filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.95))',
      }}>
        <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
                  <circle cx={half} cy={half} r="2.5" fill={color} fillOpacity="0.20" stroke="#fff" strokeWidth="0.8" />
                </svg>
      </div>

      {/* Ligne de liaison fine */}
      <svg width="2" height={Math.abs(handleOffsetY)} style={{
        position: 'absolute', left: 0, top: handleOffsetY,
        pointerEvents: 'none', overflow: 'visible',
      }}>
        <line x1="0" y1="0" x2="0" y2={Math.abs(handleOffsetY)}
          stroke="rgba(255,255,255,0.5)" strokeWidth="0.8" strokeDasharray="2 3" />
      </svg>

      {/* Poignée tactile déportée 75px au-dessus */}
      <div style={{
        position: 'absolute', left: 0, top: handleOffsetY,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'auto', cursor: 'grab',
      }} data-markerid={markerId}>
        <div style={{
          width: '16px', height: '16px', borderRadius: '50%',
          background: isActive ? color : 'rgba(255,255,255,0.85)',
          border: `1.5px solid ${color}`,
          boxShadow: '0 0 6px rgba(0,0,0,0.5)',
        }} />
        <div style={{
          textAlign: 'center', fontSize: '8px', fontWeight: 700,
          color: color, marginTop: '2px',
          textShadow: '0 1px 2px rgba(0,0,0,0.8)',
        }}>{label}</div>
      </div>
    </div>
    )
    }

  const btnStyle = (marker, accentColor) => ({
  background: activeMarker === marker ? `${accentColor}20` : 'var(--color-border)',
  color: activeMarker === marker ? accentColor : 'var(--color-text-dim)',
  border: activeMarker === marker ? `1.5px solid ${accentColor}` : '1.5px solid transparent',
  })

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
      </div>

            {/* Calibration info row */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        <span className="self-center text-[10px] font-medium" style={{ color: 'var(--color-gold)' }}>Calibrage :</span>
        <span className="self-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {calibration ? '✓ 3 repères placés' : 'Non fait'}
        </span>
      </div>

      {/* Pont buttons — Un seul bouton d'axe central du nez */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        <span className="self-center text-[10px] font-medium" style={{ color: BRIDGE_COLOR }}>Pont :</span>
        <button onClick={() => setActiveMarker('bridge')}
          className="flex-1 min-w-[120px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('bridge', BRIDGE_COLOR)}>
          <span className="w-2 h-3 rounded-sm inline-block" style={{ background: bridge ? BRIDGE_COLOR : 'var(--color-text-dim)' }} />
          Centre du Nez{bridge ? ' ✓' : ''}
        </button>
        {bridge && (
          <button onClick={() => toggleLock('bridge')}
            className="px-2 py-2 rounded-xl text-xs transition-all"
            style={{ background: isLocked('bridge') ? 'var(--color-green-bg)' : 'var(--color-border)', color: isLocked('bridge') ? 'var(--color-green)' : 'var(--color-text-dim)' }}>
            {isLocked('bridge') ? '🔒' : '🔓'}
          </button>
        )}
      </div>

      {/* Pupilles — OD + OG + locks */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        <span className="self-center text-[10px] font-medium" style={{ color: '#3b82f6' }}>Pupilles :</span>
        <button onClick={() => setActiveMarker('left')}
          className="flex-1 min-w-[55px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('left', '#3b82f6')}>
          <span className="w-3 h-3 rounded-full inline-block" style={{ background: leftEye ? '#3b82f6' : 'var(--color-text-dim)' }} />
          OD{leftEye ? ' ✓' : ''}
        </button>
        {leftEye && (
          <button onClick={() => toggleLock('left')}
            className="px-2 py-2 rounded-xl text-xs transition-all"
            style={{ background: isLocked('left') ? 'var(--color-green-bg)' : 'var(--color-border)', color: isLocked('left') ? 'var(--color-green)' : 'var(--color-text-dim)' }}>
            {isLocked('left') ? '🔒' : '🔓'}
          </button>
        )}
        <button onClick={() => setActiveMarker('right')}
          className="flex-1 min-w-[55px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('right', '#f59e0b')}>
          <span className="w-3 h-3 rounded-full inline-block" style={{ background: rightEye ? '#f59e0b' : 'var(--color-text-dim)' }} />
          OG{rightEye ? ' ✓' : ''}
        </button>
        {rightEye && (
          <button onClick={() => toggleLock('right')}
            className="px-2 py-2 rounded-xl text-xs transition-all"
            style={{ background: isLocked('right') ? 'var(--color-green-bg)' : 'var(--color-border)', color: isLocked('right') ? 'var(--color-green)' : 'var(--color-text-dim)' }}>
            {isLocked('right') ? '🔒' : '🔓'}
          </button>
        )}
      </div>

      {/* Boxing — BOX OD + BOX OG + locks */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        <span className="self-center text-[10px] font-medium" style={{ color: BOX_COLOR }}>Box :</span>
        <button onClick={() => setActiveMarker('boxOG')}
          className="flex-1 min-w-[70px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('boxOG', BOX_COLOR)}>
          <span style={{ color: boxOG ? BOX_COLOR : 'var(--color-text-dim)' }}>▣</span>
          Box OD{boxOG ? ' ✓' : ''}
        </button>
        {boxOG && (
          <button onClick={() => toggleLock('boxOG')}
            className="px-2 py-2 rounded-xl text-xs transition-all"
            style={{ background: isLocked('boxOG') ? 'var(--color-green-bg)' : 'var(--color-border)', color: isLocked('boxOG') ? 'var(--color-green)' : 'var(--color-text-dim)' }}>
            {isLocked('boxOG') ? '🔒' : '🔓'}
          </button>
        )}
        <button onClick={() => setActiveMarker('boxOD')}
          className="flex-1 min-w-[70px] py-2 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1"
          style={btnStyle('boxOD', BOX_COLOR)}>
          <span style={{ color: boxOD ? BOX_COLOR : 'var(--color-text-dim)' }}>▣</span>
          Box OG{boxOD ? ' ✓' : ''}
        </button>
        {boxOD && (
          <button onClick={() => toggleLock('boxOD')}
            className="px-2 py-2 rounded-xl text-xs transition-all"
            style={{ background: isLocked('boxOD') ? 'var(--color-green-bg)' : 'var(--color-border)', color: isLocked('boxOD') ? 'var(--color-green)' : 'var(--color-text-dim)' }}>
            {isLocked('boxOD') ? '🔒' : '🔓'}
          </button>
        )}
        <button onClick={undo} disabled={!hasAnyMarker}
          className="px-3 py-2 rounded-xl text-xs font-medium transition-opacity disabled:opacity-30 flex items-center gap-1"
          style={{ background: 'var(--color-red-bg)', color: 'var(--color-red)' }}>
          <RotateCcw size={12} /> Annuler
        </button>
      </div>

      {/* Image */}
      <div ref={containerRef} id="pupil-image-container"
        className="relative rounded-2xl border overflow-hidden select-none cursor-crosshair"
        style={{ background: '#08080a', borderColor: 'var(--color-border)', aspectRatio: imageSize ? `${imageSize.width}/${imageSize.height}` : '4/3', touchAction: 'none' }}
        onPointerDown={handleContainerPointerDown}>
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
                onChange={setBoxOG} active={activeMarker === 'boxOG'} color={BOX_COLOR} label="VOD" containerRef={containerRef} />
              <BoxingRect rect={boxOD} imageSize={imageSize} toImageCoords={toImageCoords}
                onChange={setBoxOD} active={activeMarker === 'boxOD'} color={BOX_COLOR} label="VOG" containerRef={containerRef} />

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
                                    stroke="rgba(0, 255, 127, 0.45)" strokeWidth="1" strokeDasharray="3 3" />
                                </svg>
                              )
                            })()}

              {/* Panneau live — DP / DPD / DPG en temps réel */}
              {leftEye && rightEye && (() => {
                const scale = calibration?.scalePxToMm
                const dx = rightEye.x - leftEye.x
                const dy = rightEye.y - leftEye.y
                const distPx = Math.sqrt(dx * dx + dy * dy)
                const dp = scale ? (distPx * scale).toFixed(1) : '—'
                let dpd = '—', dpg = '—'
                let pont = '—'
                let hCal = '—', lCalG = '—', lCalD = '—', hMontG = '—', hMontD = '—', em = '—'
                
                const boxOGOk = boxOG && boxOG.width > 0 && boxOG.height > 0
                const boxODOk = boxOD && boxOD.width > 0 && boxOD.height > 0
                
                // Le Pont (EIV) se calcule sur le Boxing (Bord nasal OG - Bord nasal OD) s'il est posé
                if (boxOGOk && boxODOk && scale) {
                  const nasalOD = boxOG.x + boxOG.width
                  const nasalOG = boxOD.x
                  pont = (Math.abs(nasalOG - nasalOD) * scale).toFixed(1)
                }

                if (bridge && scale) {
                  // leftEye = côté gauche image = patient OD (œil droit), rightEye = côté droit image = patient OG (œil gauche)
                  dpd = (Math.abs(leftEye.x - bridge.x) * scale).toFixed(1)  // OD (Côté gauche de l'image)
                  dpg = (Math.abs(rightEye.x - bridge.x) * scale).toFixed(1)  // OG (Côté droit de l'image)
                }
                if (scale) {
                  if (boxOG && boxOD) {
                    hCal = (((boxOG.height + boxOD.height) / 2) * scale).toFixed(1)
                  } else if (boxOG) {
                    hCal = (boxOG.height * scale).toFixed(1)
                  } else if (boxOD) {
                    hCal = (boxOD.height * scale).toFixed(1)
                  }
                  // boxOG = côté gauche = Verre OD, boxOD = côté droit = Verre OG
                  if (boxOD) lCalG = (boxOD.width * scale).toFixed(1)   // OG = œil gauche
                  if (boxOG) lCalD = (boxOG.width * scale).toFixed(1)   // OD = œil droit
                  // Hauteur de montage = distance du bas du calibre à la pupille
                  if (boxOG && leftEye) {
                    const bottomG = boxOG.y + boxOG.height / 2
                    hMontG = (Math.abs(bottomG - leftEye.y) * scale).toFixed(1)
                  }
                  if (boxOD && rightEye) {
                    const bottomD = boxOD.y + boxOD.height / 2
                    hMontD = (Math.abs(bottomD - rightEye.y) * scale).toFixed(1)
                  }
                  const lCal = (lCalG !== '—' && lCalD !== '—') ? (parseFloat(lCalG) + parseFloat(lCalD)) / 2
                    : (lCalG !== '—' ? parseFloat(lCalG) : (lCalD !== '—' ? parseFloat(lCalD) : null))
                  const p = (pont !== '—') ? parseFloat(pont) : null
                  if (lCal !== null && p !== null) {
                    em = (lCal + 0.5 * p).toFixed(1)
                  }
                }
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
                  </div>
                )
              })()}
            </div>
          )
        })()}

        <div className="absolute bottom-3 left-0 right-0 text-center pointer-events-none" style={{ zIndex: 50 }}>
          <span className="inline-block px-3 py-1.5 rounded-full text-xs"
            style={{ background: 'rgba(0,0,0,0.7)', color: '#ccc', border: '1px solid rgba(255,255,255,0.1)' }}>
            {result?.pupilsOk && result?.pontOk && (boxOG || boxOD) ? 'Tous les repères placés · Validez'
              : `Placez : ${
                activeMarker === 'bridgeL' ? 'PD' : activeMarker === 'bridgeR' ? 'PG'
                : activeMarker === 'left' ? 'Pupille OD' : activeMarker === 'right' ? 'Pupille OG'
                : activeMarker === 'boxOG' ? 'Box OD' : activeMarker === 'boxOD' ? 'Box OG' : ''}`}
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
        <button onClick={confirm} disabled={!result?.pupilsOk}
          className="flex items-center justify-center gap-1.5 flex-1 py-3 rounded-full font-medium text-sm text-white transition-all hover:opacity-90 disabled:opacity-40"
          style={{ background: 'var(--color-gold)' }}>
          <Check size={16} /> Valider la mesure
        </button>
      </div>

      {result?.pupilsOk && (!result?.pontOk || !result?.frameOk) && (
        <div className="text-center">
          <p className="text-xs" style={{ color: 'var(--color-gold)' }}>
            {!result.pontOk ? '💡 Placez le Centre du Nez pour la DP mono réelle. ' : ''}
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
