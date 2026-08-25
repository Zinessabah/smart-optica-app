import { useState, useRef, useCallback, useEffect } from 'react'
import { ArrowLeft, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'
import { analyzeProfile } from './services/api'

/**
 * Mesures latérales (profil D) — étape séparée après la capture de la photo.
 * Pas d'auto-détection : l'opticien place manuellement les 2 points cyan sur les mires latérales (25mm fixe).
 * L'échelle est déduite : 25mm / distance_px.
 * Segments : temple 🟠, plan verre 🔵, vertex 🟢 (cornée ↔ face arrière verre).
 */
export default function ProfileMeasure({ imageUrl, calibrationScale, onCapture, onSkip, onBack }) {
  const [imageSize, setImageSize] = useState(null)
  const [error, setError] = useState(null)

  // Mesure manuelle
  const [templeLine, setTempleLine] = useState([])   // 2 points branche
  const [lensLine, setLensLine] = useState([])        // 2 points plan verre (⟂ aux mires)
  const [vertexLine, setVertexLine] = useState([])    // 2 points cornée→verre
  const dragRef = useRef(null)

  // vertexNeedsCompute doit être déclaré AVANT runAutoDetect qui l'utilise
  const [vertexNeedsCompute, setVertexNeedsCompute] = useState(false)

  // ── Vérification manuelle du calibrage 25 mm (2 points sur les mires latérales) ──
  const [verifyActive, setVerifyActive] = useState(true) // OUVERT par défaut
  const [verifyLine, setVerifyLine] = useState([])   // 2 points sur les mires latérales

  // Échelle déduite de la vérification manuelle (25mm / distance_px)
  const verifyResult = (() => {
    if (verifyLine.length < 2) return null
    const d = Math.hypot(verifyLine[1].x - verifyLine[0].x, verifyLine[1].y - verifyLine[0].y)
    if (d === 0) return { px: 0, impliedScale: null }
    const impliedScale = 25 / d  // 25mm FIXE / distance en pixels
    return { px: Math.round(d), impliedScale }
  })()

  // Échelle effective = vérification manuelle OU calibration frontale (repli)
  const effectiveScale = verifyResult?.impliedScale || calibrationScale

  // ── Chargement de l'image déjà capturée ──
  useEffect(() => {
    const img = new Image()
    img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => setError('Image de profil illisible')
    img.src = imageUrl
  }, [imageUrl])

  // ── Auto-détection latérale (backend) pour PRÉ-PLACER les marqueurs cyan ──
  const [autoDetected, setAutoDetected] = useState(false)
  
  const runAutoDetect = useCallback(async () => {
    if (!imageUrl || !imageSize || autoDetected) return
    setAutoDetected(true)
    try {
      console.log('[ProfileMeasure] 🔍 Auto-détection mires latérales — pré-placement initial')
      const resp = await fetch(imageUrl)
      const blob = await resp.blob()
      // Appel SANS calibrationScale — le backend auto-calibre sur 25mm
      const data = await analyzeProfile(blob, null)
      console.log('[ProfileMeasure] ✅ Backend response:', JSON.stringify(data, null, 2))
      
      // Pré-placer les marqueurs cyan SUR les mires détectées
      if (data?.lateral_markers && data.lateral_markers.length === 2) {
        const verify = [
          { x: Math.round(data.lateral_markers[0][0]), y: Math.round(data.lateral_markers[0][1]) },
          { x: Math.round(data.lateral_markers[1][0]), y: Math.round(data.lateral_markers[1][1]) }
        ]
        setVerifyLine(verify)
        setVerifyActive(true) // ouvre la vérification
        console.log('[ProfileMeasure] 🎯 Marqueurs cyan pré-placés sur mires détectées')
      }
      // Pré-placer temple + lens + vertex si dispo
      if (data?.temple_line && data.temple_line.length === 2) {
        setTempleLine(data.temple_line.map(([x,y]) => ({x: Math.round(x), y: Math.round(y)})))
      }
      if (data?.lens_line && data.lens_line.length === 2) {
        setLensLine(data.lens_line.map(([x,y]) => ({x: Math.round(x), y: Math.round(y)})))
      } else if (data?.lateral_markers && data.lateral_markers.length === 2) {
        // Calculer ⟂ aux mires
        const [m1, m2] = data.lateral_markers
        const cx = (m1[0] + m2[0]) / 2, cy = (m1[1] + m2[1]) / 2
        const dx = m2[0] - m1[0], dy = m2[1] - m1[1]
        const px = -dy, py = dx, len = Math.hypot(px, py) || 1
        const halfLen = 120
        setLensLine([
          { x: Math.round(cx - px/len * halfLen), y: Math.round(cy - py/len * halfLen) },
          { x: Math.round(cx + px/len * halfLen), y: Math.round(cy + py/len * halfLen) }
        ])
      }
      if (data?.vertex_line && data.vertex_line.length === 2) {
        setVertexLine(data.vertex_line.map(([x,y]) => ({x: Math.round(x), y: Math.round(y)})))
        vertexNeedsCompute.current = true
      }
    } catch (e) {
      console.warn('[ProfileMeasure] Auto-détection indisponible:', e.message)
    }
  }, [imageUrl, imageSize, vertexNeedsCompute])

  // Lancement auto au chargement
  useEffect(() => {
    if (!imageSize || autoDetected) return
    runAutoDetect()
  }, [imageSize, runAutoDetect, autoDetected])

  // Bouton relancer auto-détection
  const handleAutoDetect = useCallback(() => {
    setAutoDetected(false)
    runAutoDetect()
  }, [runAutoDetect])

  // ── Auto-placer le plan verre (⟂ aux mires) quand vérification faite ──
  useEffect(() => {
    if (verifyResult && lensLine.length === 0 && imageSize) {
      const [m1, m2] = verifyLine
      const cx = (m1.x + m2.x) / 2
      const cy = (m1.y + m2.y) / 2
      const dx = m2.x - m1.x
      const dy = m2.y - m1.y
      const px = -dy, py = dx
      const len = Math.hypot(px, py) || 1
      const halfLen = 120
      const lens = [
        { x: Math.round(cx - px/len * halfLen), y: Math.round(cy - py/len * halfLen) },
        { x: Math.round(cx + px/len * halfLen), y: Math.round(cy + py/len * halfLen) }
      ]
      setLensLine(lens)
    }
  }, [verifyResult, lensLine.length, imageSize])

  const allAngleDone = templeLine.length >= 2 && lensLine.length >= 2
  useEffect(() => {
    if (allAngleDone && vertexLine.length === 0 && imageSize) {
      const cx = Math.round(imageSize.width / 2)
      const cy = Math.round(imageSize.height / 2)
      setVertexLine([{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }])
      setVertexNeedsCompute(true)
    }
  }, [allAngleDone, vertexLine.length, imageSize])

  // ── Vertex → API backend ──
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
  }, [vertexLine, computeVertexFromAPI])

  const allDone = allAngleDone && vertexLine.length === 2

  // ── Drag & drop des extrémités ──
  const handlePointerDown = useCallback((e) => {
    const ep = e.target.closest('[data-seg-type]')
    if (!ep || !imageSize) return
    e.stopPropagation()
    const segType = ep.dataset.segType
    const index = parseInt(ep.dataset.segIndex)
    const setter = segType === 'temple' ? setTempleLine
      : segType === 'lens' ? setLensLine
      : segType === 'vertex' ? setVertexLine
      : segType === 'verify' ? setVerifyLine : null
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
      const wasVerify = dragRef.current?.setter === setVerifyLine
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (wasVertex) setVertexNeedsCompute(true)
    }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp)
  }, [imageSize])

  // ── Clic pour placer temple/lens/verify ──
  const handleImageClick = useCallback((e) => {
    if (!imageSize) return
    if (e.target.closest('[data-seg-type]')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pt = { x: Math.round((e.clientX - rect.left) / rect.width * imageSize.width), y: Math.round((e.clientY - rect.top) / rect.height * imageSize.height) }
    if (verifyActive && verifyLine.length < 2) {
      setVerifyLine(prev => [...prev, pt])
    } else if (templeLine.length < 2) {
      setTempleLine(prev => [...prev, pt])
    } else if (lensLine.length < 2) {
      setLensLine(prev => [...prev, pt])
    }
  }, [imageSize, templeLine, lensLine, verifyActive, verifyLine])

  // ── Calcul angle pantoscopique ──
  const angleData = (() => {
    if (templeLine.length < 2 || lensLine.length < 2) return null
    const tdx = templeLine[1].x - templeLine[0].x
    const tdy = templeLine[1].y - templeLine[0].y
    const templeDeg = Math.atan2(tdy, tdx) * 180 / Math.PI
    const ldx = lensLine[1].x - lensLine[0].x
    const ldy = lensLine[1].y - lensLine[0].y
    const lensDeg = Math.atan2(ldy, ldx) * 180 / Math.PI
    const between = Math.abs(lensDeg - templeDeg)
    const pantoscopic = between > 90 ? between - 90 : 90 - between
    return {
      templeDeg: Math.round(templeDeg * 10) / 10,
      lensDeg: Math.round(lensDeg * 10) / 10,
      pantoscopic: Math.round(Math.max(0, Math.min(30, pantoscopic)) * 10) / 10,
    }
  })()

  // ── Reset ──
  const resetMeasure = useCallback(() => { 
    setTempleLine([]); setLensLine([]); setVertexLine([]); setVertexMm(null); setVerifyLine([]) 
  }, [])

  // ── Validation ──
  const confirm = useCallback(() => {
    onCapture({
      width: imageSize?.width || 0, height: imageSize?.height || 0,
      lateral_markers: verifyLine.length === 2 ? [[verifyLine[0].x, verifyLine[0].y], [verifyLine[1].x, verifyLine[1].y]] : null,
      temple_markers: [[templeLine[0].x, templeLine[0].y], [templeLine[1].x, templeLine[1].y]],
      vertex_markers: vertexLine.length === 2 ? [[vertexLine[0].x, vertexLine[0].y], [vertexLine[1].x, vertexLine[1].y]] : null,
      pantoscopic_angle: angleData?.pantoscopic || 0,
      vertex_distance: vertexMm,
      manual: true, face_detected: false,
      scale_mm_per_px: effectiveScale || 0,
    })
  }, [imageSize, verifyLine, templeLine, vertexLine, angleData, vertexMm, effectiveScale, onCapture])

  // ── Rendu SVG ──
  const toPct = (v, d) => `${(v / d) * 100}%`

  const renderSegments = () => {
    if (!imageSize) return null
    return (
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 10 }}>
        {templeLine.length >= 2 && (
          <line x1={toPct(templeLine[0].x, imageSize.width)} y1={toPct(templeLine[0].y, imageSize.height)}
            x2={toPct(templeLine[1].x, imageSize.width)} y2={toPct(templeLine[1].y, imageSize.height)}
            stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />
        )}
        {lensLine.length >= 2 && (
          <line x1={toPct(lensLine[0].x, imageSize.width)} y1={toPct(lensLine[0].y, imageSize.height)}
            x2={toPct(lensLine[1].x, imageSize.width)} y2={toPct(lensLine[1].y, imageSize.height)}
            stroke="#3b9eff" strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />
        )}
        {vertexLine.length >= 2 && (() => {
          const [p1, p2] = vertexLine
          const dx = p2.x - p1.x, dy = p2.y - p1.y
          const len = Math.sqrt(dx*dx + dy*dy) || 1
          const px = -(dy / len), py = (dx / len)
          const tick = 8
          return (
            <>
              <line x1={toPct(p1.x, imageSize.width)} y1={toPct(p1.y, imageSize.height)}
                x2={toPct(p2.x, imageSize.width)} y2={toPct(p2.y, imageSize.height)}
                stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" opacity="0.8" strokeDasharray="6 3" />
              <line x1={toPct(p1.x - px*tick, imageSize.width)} y1={toPct(p1.y - py*tick, imageSize.height)}
                x2={toPct(p1.x + px*tick, imageSize.width)} y2={toPct(p1.y + py*tick, imageSize.height)}
                stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" opacity="0.9" />
              <line x1={toPct(p2.x - px*tick, imageSize.width)} y1={toPct(p2.y - py*tick, imageSize.height)}
                x2={toPct(p2.x + px*tick, imageSize.width)} y2={toPct(p2.y + py*tick, imageSize.height)}
                stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" opacity="0.9" />
            </>
          )
        })()}
        {allAngleDone && angleData && (() => {
          const cx = (templeLine[0].x + templeLine[1].x + lensLine[0].x + lensLine[1].x) / 4
          const cy = (templeLine[0].y + templeLine[1].y + lensLine[0].y + lensLine[1].y) / 4
          return (
            <g transform={`translate(${toPct(cx, imageSize.width).replace('%','')},${toPct(cy, imageSize.height).replace('%','')})`}>
              <circle cx="0" cy="0" r="26" fill="none" stroke="#f59e0b" strokeWidth="1.2" opacity="0.5" strokeDasharray="3 2" />
              <text x="0" y="4" fontSize="10" fill="#f59e0b" fontWeight="700" textAnchor="middle" dominantBaseline="middle"
                style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.8))' }}>{angleData.pantoscopic}°</text>
            </g>
          )
        })()}
      </svg>
    )
  }

  const renderEndpoints = (points, color, segType) => {
    if (!imageSize) return null
    return points.map((pt, i) => (
      <div key={i} data-seg-type={segType} data-seg-index={i} style={{
        position: 'absolute', left: toPct(pt.x, imageSize.width), top: toPct(pt.y, imageSize.height),
        transform: 'translate(-50%,-50%)', width: 24, height: 24, borderRadius: '50%',
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

  const step = templeLine.length < 2 ? 'temple' : lensLine.length < 2 ? 'lens' : vertexLine.length < 2 ? 'vertex' : 'done'
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
          {renderSegments()}
          {renderEndpoints(templeLine, '#f59e0b', 'temple')}
          {renderEndpoints(lensLine, '#3b9eff', 'lens')}
          {verifyActive && renderEndpoints(verifyLine, '#22d3ee', 'verify')}
          {/* Handles vertex discrets (16px, transparents) pour le drag */}
          {vertexLine.length === 2 && vertexLine.map((pt, i) => (
            <div key={`vh${i}`} data-seg-type="vertex" data-seg-index={i} style={{
              position: 'absolute', left: `${(pt.x / imageSize.width) * 100}%`, top: `${(pt.y / imageSize.height) * 100}%`,
              transform: 'translate(-50%,-50%)', width: 16, height: 16, borderRadius: '50%',
              background: 'transparent', cursor: 'grab', touchAction: 'none', pointerEvents: 'auto', zIndex: 16,
            }} />
          ))}
        </div>
      </div>

      <div className="rounded-xl px-4 py-3 text-xs" style={{
        background: step === 'done' ? 'var(--color-green-bg)' : step === 'vertex' ? 'rgba(16,185,129,0.08)' : 'var(--color-purple-bg)',
        color: step === 'done' ? 'var(--color-green)' : step === 'vertex' ? '#10b981' : 'var(--color-purple)',
        borderWidth: 1, borderStyle: 'solid',
        borderColor: step === 'done' ? 'rgba(16,185,129,0.25)' : step === 'vertex' ? 'rgba(16,185,129,0.2)' : 'rgba(139,92,246,0.2)',
      }}>
        {step === 'temple' && <>🟠 Placez 2 points sur la <strong>branche</strong> ({templeLine.length}/2)</>}
        {step === 'lens' && <>🔵 Placez 2 points sur le <strong>plan du verre</strong> (auto ⟂ aux mires) ({lensLine.length}/2)</>}
        {step === 'vertex' && <>🟢 <strong>Segment vertex</strong> placé — ajustez cornée (gauche) et face arrière du verre (droite)</>}
        {step === 'done' && angleData && <>✅ Pantoscopique <strong>{angleData.pantoscopic}°</strong> | Vertex <strong>{vertexLoading ? '...' : vertexMm ? `${vertexMm} mm` : '—'}</strong></>}
      </div>

      {/* Échelle de mesure — basée sur les 2 mires latérales (25mm FIXE) */}
      {verifyResult && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
          style={{ background: 'rgba(34,211,238,0.1)', color: '#22d3ee', border: '1px solid rgba(34,211,238,0.3)' }}>
          <span className="flex-1">
            📏 Calibrage manuel : <strong>25.0 mm</strong> = {verifyResult.px} px → <strong>1 px = {verifyResult.impliedScale.toFixed(4)} mm</strong>
          </span>
        </div>
      )}

      {/* Vérification du calibrage 25 mm (2 points sur les cercles noirs latéraux) */}
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setVerifyActive(v => { const n = !v; if (n) setVerifyLine([]); return n })}
          className="flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-medium transition-all hover:opacity-90"
          style={{
            background: verifyActive ? 'rgba(34,211,238,0.15)' : 'var(--color-border)',
            color: verifyActive ? '#22d3ee' : 'var(--color-text-muted)',
            border: verifyActive ? '1.5px solid #22d3ee' : '1.5px solid transparent',
          }}>
          {verifyActive ? '✕ Fermer la vérification 25mm' : '🔍 Ouvrir la vérification 25mm'}
        </button>
        {verifyActive && verifyLine.length > 0 && (
          <button onClick={() => setVerifyLine([])} className="text-xs underline decoration-dotted hover:opacity-80"
            style={{ color: 'var(--color-text-muted)' }}>
            Recommencer
          </button>
        )}
        {/* Bouton relancer auto-détection */}
        <button onClick={handleAutoDetect} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium hover:opacity-80"
          style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--color-purple)', border: '1px solid rgba(139,92,246,0.3)' }}>
          ↻ Re-détecter mires
        </button>
      </div>

      {verifyActive && (
        <div className="rounded-xl px-4 py-3 text-xs border"
          style={{
            background: verifyResult ? 'var(--color-green-bg)' : 'var(--color-bg)',
            borderColor: verifyResult ? 'rgba(34,197,94,0.3)' : 'var(--color-border)',
          }}>
          {!verifyResult ? (
            <span style={{ color: 'var(--color-text-muted)' }}>
              {verifyLine.length < 2
                ? 'Placez 2 points (reliés par une droite cyan) sur les 2 cercles noirs latéraux.'
                : 'Échelle indisponible'}
            </span>
          ) : (
            <div className="space-y-1">
              <div className="flex justify-between">
                <span style={{ color: 'var(--color-text-muted)' }}>Distance réelle entre les 2 mires (fixe)</span>
                <span className="font-bold" style={{ color: 'var(--color-green)' }}>25.0 mm</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--color-text-muted)' }}>Échelle calculée (25 mm / distance px)</span>
                <span style={{ color: '#22d3ee', fontWeight: 600 }}>1 px = {verifyResult.impliedScale.toFixed(4)} mm</span>
              </div>
              <div style={{ color: 'var(--color-green)' }}>
                ✅ Calibrage manuel validé — cette échelle sert pour vertex + mesures
              </div>
            </div>
          )}
        </div>
      )}

      {allAngleDone && angleData && (
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="py-2 rounded-xl" style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}>
            <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Branche</div>
            <div className="text-lg font-semibold" style={{ color: '#f59e0b' }}>{angleData.templeDeg}°</div>
          </div>
          <div className="py-2 rounded-xl" style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}>
            <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Plan verre</div>
            <div className="text-lg font-semibold" style={{ color: '#3b9eff' }}>{angleData.lensDeg}°</div>
          </div>
          <div className="py-2 rounded-xl" style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}>
            <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Pantoscopique</div>
            <div className="text-lg font-semibold" style={{ color: 'var(--color-purple)' }}>{angleData.pantoscopic}°</div>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={onBack} className="flex items-center justify-center gap-1.5 flex-1 py-2.5 rounded-full text-sm font-medium"
          style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
          <ArrowLeft size={14} /> Retour
        </button>
        <button onClick={resetMeasure} className="flex-1 py-2.5 rounded-full text-sm font-medium"
          style={{ background: 'var(--color-border)', color: allAngleDone ? 'var(--color-text-muted)' : 'var(--color-text-dim)', opacity: allAngleDone ? 1 : 0.5 }}
          disabled={!allAngleDone}>Refaire</button>
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