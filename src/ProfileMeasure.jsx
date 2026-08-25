import { useState, useRef, useCallback, useEffect } from 'react'
import { ArrowLeft, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'

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
  const [vertexNeedsCompute, setVertexNeedsCompute] = useState(false)

  // ── Chargement de l'image ──
  useEffect(() => {
    const img = new Image()
    img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => setError('Image de profil illisible')
    img.src = imageUrl
  }, [imageUrl])

  const allAngleDone = anglePts.length >= 3

  // ── Vertex auto-placé au centre quand l'angle est fait ──
  useEffect(() => {
    if (allAngleDone && vertexLine.length === 0 && imageSize) {
      const cx = Math.round(imageSize.width / 2)
      const cy = Math.round(imageSize.height / 2)
      setVertexLine([{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }])
      setVertexNeedsCompute(true)
    }
  }, [allAngleDone, vertexLine.length, imageSize])

  // ── Vertex → API backend (distance pure, sans correction) ──
  const [vertexMm, setVertexMm] = useState(null)
  const [vertexLoading, setVertexLoading] = useState(false)

  const computeVertexFromAPI = useCallback(async () => {
    if (vertexLine.length < 2 || !effectiveScale) return
    setVertexLoading(true)
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
      if (res.ok) {
        const data = await res.json()
        setVertexMm(data.vertex_distance_mm)
      }
    } catch { /* silencieux */ }
    setVertexLoading(false)
  }, [vertexLine, effectiveScale])

  useEffect(() => {
    if (vertexLine.length === 2 && vertexNeedsCompute) {
      setVertexNeedsCompute(false)
      computeVertexFromAPI()
    }
  }, [vertexLine, vertexNeedsCompute, computeVertexFromAPI])

  const allDone = allAngleDone && vertexLine.length === 2

  // ── Drag & drop des poignées (data-pt-type + data-pt-index) ──
  const handlePointerDown = useCallback((e) => {
    const ep = e.target.closest('[data-pt-type]')
    if (!ep || !imageSize) return
    e.stopPropagation()
    const ptType = ep.dataset.ptType
    const index = parseInt(ep.dataset.ptIndex)
    const setter = { verify: setVerifyLine, angle: setAnglePts, vertex: setVertexLine }[ptType]
    if (!setter) return
    const rect = e.currentTarget.getBoundingClientRect()

    setter(prev => {
      const orig = prev[index]; if (!orig) return prev
      dragRef.current = { setter, index, sX: e.clientX, sY: e.clientY, oX: orig.x, oY: orig.y, rect }
      return prev
    })
    const onMove = (ev) => {
      const d = dragRef.current; if (!d) return
      const nx = Math.round(Math.max(0, Math.min(imageSize.width, d.oX + (ev.clientX - d.sX) / d.rect.width * imageSize.width)))
      const ny = Math.round(Math.max(0, Math.min(imageSize.height, d.oY + (ev.clientY - d.sY) / d.rect.height * imageSize.height)))
      d.setter(prev => { const n = [...prev]; n[d.index] = { x: nx, y: ny }; return n })
    }
    const onUp = () => {
      const wasVertex = dragRef.current?.setter === setVertexLine
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (wasVertex) setVertexNeedsCompute(true)
    }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp)
  }, [imageSize])

  // ── Clic pour placer les points dans l'ordre : mires → angle → (vertex auto) ──
  const handleImageClick = useCallback((e) => {
    if (!imageSize) return
    if (e.target.closest('[data-pt-type]')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pt = { x: Math.round((e.clientX - rect.left) / rect.width * imageSize.width), y: Math.round((e.clientY - rect.top) / rect.height * imageSize.height) }
    if (verifyLine.length < 2) {
      setVerifyLine(prev => [...prev, pt])
    } else if (anglePts.length < 3) {
      setAnglePts(prev => [...prev, pt])
    }
  }, [imageSize, verifyLine, anglePts])

  // ── Angle pantoscopique : écart à 90° de l'angle entre les 2 segments ──
  // Le plan du verre est perpendiculaire à la branche → angle brut ≈ 90°.
  // La pantoscopie est la DÉVIATION par rapport à cette perpendiculaire.
  const pantoscopic = (() => {
    if (anglePts.length < 3) return null
    const [a, v, b] = anglePts
    const v1 = Math.atan2(a.y - v.y, a.x - v.x) * 180 / Math.PI
    const v2 = Math.atan2(b.y - v.y, b.x - v.x) * 180 / Math.PI
    let ang = Math.abs(v2 - v1)
    if (ang > 180) ang = 360 - ang
    const deviation = Math.abs(ang - 90)
    return Math.round(Math.max(0, Math.min(30, deviation)) * 10) / 10
  })()

  // ── Reset ──
  const resetMeasure = useCallback(() => {
    setVerifyLine([]); setAnglePts([]); setVertexLine([]); setVertexMm(null)
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
        {/* Ligne de calibrage cyan */}
        {verifyLine.length >= 2 && (
          <line x1={toPct(verifyLine[0].x, imageSize.width)} y1={toPct(verifyLine[0].y, imageSize.height)}
            x2={toPct(verifyLine[1].x, imageSize.width)} y2={toPct(verifyLine[1].y, imageSize.height)}
            stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" opacity="0.8" strokeDasharray="5 3" />
        )}
        {/* Angle : 2 segments reliés au sommet */}
        {anglePts.length >= 2 && (
          <>
            <line x1={toPct(anglePts[0].x, imageSize.width)} y1={toPct(anglePts[0].y, imageSize.height)}
              x2={toPct(anglePts[1].x, imageSize.width)} y2={toPct(anglePts[1].y, imageSize.height)}
              stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />
            {anglePts.length >= 3 && (
              <line x1={toPct(anglePts[1].x, imageSize.width)} y1={toPct(anglePts[1].y, imageSize.height)}
                x2={toPct(anglePts[2].x, imageSize.width)} y2={toPct(anglePts[2].y, imageSize.height)}
                stroke="#3b9eff" strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />
            )}
          </>
        )}
        {/* Arc d'angle + valeur */}
        {pantoscopic !== null && (() => {
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
        {vertexLine.length >= 2 && (
          <line x1={toPct(vertexLine[0].x, imageSize.width)} y1={toPct(vertexLine[0].y, imageSize.height)}
            x2={toPct(vertexLine[1].x, imageSize.width)} y2={toPct(vertexLine[1].y, imageSize.height)}
            stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" opacity="0.8" strokeDasharray="6 3" />
        )}
      </svg>
    )
  }

  const renderEndpoints = () => {
    if (!imageSize) return null
    const items = []
    verifyLine.forEach((pt, i) => items.push({ pt, color: '#22d3ee', type: 'verify', i, size: 22 }))
    anglePts.forEach((pt, i) => items.push({
      pt,
      color: i === 1 ? '#a78bfa' : i === 0 ? '#f59e0b' : '#3b9eff',
      type: 'angle', i, size: i === 1 ? 26 : 22,
    }))
    vertexLine.forEach((pt, i) => items.push({ pt, color: '#10b981', type: 'vertex', i, size: 18 }))
    return items.map(({ pt, color, type, i, size }, k) => (
      <div key={`${type}${k}`} data-pt-type={type} data-pt-index={i} style={{
        position: 'absolute', left: toPct(pt.x, imageSize.width), top: toPct(pt.y, imageSize.height),
        transform: 'translate(-50%,-50%)', width: size, height: size, borderRadius: '50%',
        background: `${color}33`, border: `2.5px solid ${color}`, boxShadow: `0 0 8px ${color}66`,
        cursor: 'grab', touchAction: 'none', pointerEvents: 'auto', zIndex: 15,
      }} />
    ))
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

  const step = verifyLine.length < 2 ? 'calib' : anglePts.length < 3 ? 'angle' : 'done'
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

      <div className="rounded-2xl border overflow-hidden relative" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
        <div className="relative select-none" style={{ touchAction: 'none' }}
          onPointerDown={handlePointerDown} onClick={handleImageClick}>
          <img src={imageUrl} alt="Profil" className="w-full aspect-[3/4] object-contain pointer-events-none" />
          {renderLines()}
          {renderEndpoints()}
        </div>
      </div>

      <div className="rounded-xl px-4 py-3 text-xs" style={{
        background: step === 'done' ? 'var(--color-green-bg)' : step === 'angle' ? 'rgba(167,139,250,0.08)' : 'rgba(34,211,238,0.08)',
        color: step === 'done' ? 'var(--color-green)' : step === 'angle' ? '#a78bfa' : '#22d3ee',
        borderWidth: 1, borderStyle: 'solid',
        borderColor: step === 'done' ? 'rgba(16,185,129,0.25)' : step === 'angle' ? 'rgba(167,139,250,0.25)' : 'rgba(34,211,238,0.3)',
      }}>
        {step === 'calib' && <>🔷 Placez 2 points sur les <strong>2 cercles noirs</strong> ({verifyLine.length}/2)</>}
        {step === 'angle' && <>🟠🔵 Placez le <strong>sommet 🟣</strong> puis les 2 extrémités sur la branche et le plan du verre ({anglePts.length}/3)</>}
        {step === 'done' && <>✅ Pantoscopique <strong>{pantoscopic}°</strong> | Vertex <strong>{vertexLoading ? '...' : vertexMm ? `${vertexMm} mm` : '—'}</strong></>}
      </div>

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
