import { useState, useRef, useCallback, useEffect } from 'react'
import { Camera, Upload, ArrowLeft, CheckCircle2, AlertTriangle, Loader2, Ruler } from 'lucide-react'
import Webcam from './Webcam'

export default function ProfilePhoto({ onCapture, onSkip, onBack, initialMode, calibrationScale }) {
  const [mode, setMode] = useState(initialMode || null)
  const [imagePreview, setImagePreview] = useState(null)
  const [imageSize, setImageSize] = useState(null)
  const [error, setError] = useState(null)

  // Mesure manuelle
  const [templeLine, setTempleLine] = useState([])   // 2 points branche
  const [lensLine, setLensLine] = useState([])        // 2 points plan verre
  const [vertexLine, setVertexLine] = useState([])    // 2 points cornée→verre
  const dragRef = useRef(null)
  const fileInputRef = useRef(null)

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
    // Pantoscopique = écart du plan verre par rapport à la verticale,
    // après correction de l'inclinaison caméra via la branche
    const pantoscopic = between > 90 ? between - 90 : 90 - between
    return {
      templeDeg: Math.round(templeDeg * 10) / 10,
      lensDeg: Math.round(lensDeg * 10) / 10,
      pantoscopic: Math.round(Math.max(0, Math.min(30, pantoscopic)) * 10) / 10,
    }
  })()

  // ── Vertex → API backend ──
  const [vertexMm, setVertexMm] = useState(null)
  const [vertexLoading, setVertexLoading] = useState(false)
  const vertexNeedsCompute = useRef(false)

  const computeVertexFromAPI = useCallback(async () => {
    if (vertexLine.length < 2 || !calibrationScale) return
    setVertexLoading(true)
    try {
      const res = await fetch('/api/compute-vertex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cornea_x: vertexLine[0].x, cornea_y: vertexLine[0].y,
          lens_back_x: vertexLine[1].x, lens_back_y: vertexLine[1].y,
          scale_mm_per_px: calibrationScale,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setVertexMm(data.vertex_distance_mm)
      }
    } catch { /* silencieux */ }
    setVertexLoading(false)
  }, [vertexLine, calibrationScale])

  const allAngleDone = templeLine.length >= 2 && lensLine.length >= 2

  // Auto-placer le segment vertex au centre quand le plan verre est prêt
  useEffect(() => {
    if (allAngleDone && vertexLine.length === 0 && imageSize) {
      const cx = Math.round(imageSize.width / 2)
      const cy = Math.round(imageSize.height / 2)
      setVertexLine([{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }])
      vertexNeedsCompute.current = true
    }
  }, [allAngleDone, vertexLine.length, imageSize])

  // Appeler l'API après placement ou drag
  useEffect(() => {
    if (vertexLine.length === 2 && vertexNeedsCompute.current) {
      vertexNeedsCompute.current = false
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
    const setter = segType === 'temple' ? setTempleLine : segType === 'lens' ? setLensLine : segType === 'vertex' ? setVertexLine : null
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
      if (wasVertex) vertexNeedsCompute.current = true
    }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp)
  }, [imageSize])

  // ── Reset ──
  const resetMeasure = useCallback(() => { setTempleLine([]); setLensLine([]); setVertexLine([]); setVertexMm(null) }, [])
  const resetAll = useCallback(() => {
    setMode(null); setImagePreview(null); setImageSize(null); setError(null); resetMeasure()
  }, [resetMeasure])

  // ── Chargement image ──
  const loadImage = useCallback((url) => {
    setImagePreview(url)
    const img = new Image()
    img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
    img.src = url
  }, [])

  const readFile = useCallback((file) => new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('Fichier non valide'))
    const r = new FileReader(); r.onload = e => resolve(e.target.result); r.onerror = () => reject(new Error('Erreur lecture'))
    r.readAsDataURL(file)
  }), [])

  const handleFile = useCallback(async (e) => {
    const f = e.target.files?.[0]; if (!f) return; e.target.value = ''
    try { const url = await readFile(f); loadImage(url); setMode('measure') }
    catch (err) { setError(err.message) }
  }, [readFile, loadImage])

  const handleWebcam = useCallback((url) => { loadImage(url); setMode('measure') }, [loadImage])

  // ── Clic pour placer temple/lens ──
  const handleImageClick = useCallback((e) => {
    if (mode !== 'measure' || !imageSize) return
    if (e.target.closest('[data-seg-type]')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pt = { x: Math.round((e.clientX - rect.left) / rect.width * imageSize.width), y: Math.round((e.clientY - rect.top) / rect.height * imageSize.height) }
    if (templeLine.length < 2) setTempleLine(prev => [...prev, pt])
    else if (lensLine.length < 2) setLensLine(prev => [...prev, pt])
  }, [mode, imageSize, templeLine, lensLine])

  // ── Validation ──
  const confirm = useCallback(() => {
    onCapture({
      data: {
        width: imageSize?.width || 0, height: imageSize?.height || 0,
        lateral_markers: [[lensLine[0].x, lensLine[0].y], [lensLine[1].x, lensLine[1].y]],
        temple_markers: [[templeLine[0].x, templeLine[0].y], [templeLine[1].x, templeLine[1].y]],
        vertex_markers: vertexLine.length === 2 ? [[vertexLine[0].x, vertexLine[0].y], [vertexLine[1].x, vertexLine[1].y]] : null,
        pantoscopic_angle: angleData?.pantoscopic || 0,
        vertex_distance: vertexMm,
        manual: true, face_detected: false,
        scale_mm_per_px: calibrationScale || 0,
      },
      imageUrl: imagePreview,
    })
  }, [imagePreview, imageSize, lensLine, templeLine, vertexLine, angleData, vertexMm, calibrationScale, onCapture])

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
            stroke="#8b5cf6" strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />
        )}
        {vertexLine.length >= 2 && (() => {
          const [p1, p2] = vertexLine
          const dx = p2.x - p1.x, dy = p2.y - p1.y
          const len = Math.sqrt(dx*dx + dy*dy) || 1
          const px = -(dy / len), py = (dx / len)  // vecteur perpendiculaire
          const tick = 8  // demi-longueur du tick
          return (
            <>
              <line x1={toPct(p1.x, imageSize.width)} y1={toPct(p1.y, imageSize.height)}
                x2={toPct(p2.x, imageSize.width)} y2={toPct(p2.y, imageSize.height)}
                stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" opacity="0.8" strokeDasharray="6 3" />
              {/* Ticks perpendiculaires aux extrémités */}
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
          <button onClick={resetAll} className="px-6 py-2.5 rounded-full font-medium text-sm"
            style={{ background: 'var(--color-gold)', color: 'var(--color-bg)' }}>Réessayer</button>
        </div>
      </div>
    )
  }

  if (mode === 'camera') return <Webcam onCapture={handleWebcam} onCancel={() => setMode(null)} mirror={false} />

  if (mode === 'upload') {
    return (
      <div className="rounded-2xl border overflow-hidden animate-fade-in" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
        <div className="flex flex-col items-center justify-center py-16 px-6 cursor-pointer" style={{ minHeight: 240 }}
          onClick={() => fileInputRef.current?.click()}>
          <Upload size={28} style={{ color: 'var(--color-purple)', marginBottom: 12 }} />
          <p className="text-base font-medium" style={{ color: 'var(--color-text)' }}>Photo de profil (côté DROIT)</p>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
          <button className="mt-5 px-6 py-2.5 rounded-full font-medium text-sm" style={{ background: 'var(--color-gold)', color: 'var(--color-bg)' }}
            onClick={e => { e.stopPropagation(); fileInputRef.current?.click() }}>Choisir</button>
        </div>
        <div className="px-4 py-3 flex justify-center border-t" style={{ borderColor: 'var(--color-border)' }}>
          <button onClick={resetAll} className="px-4 py-2 rounded-full text-sm" style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
            <ArrowLeft size={14} className="inline mr-1" />Retour</button>
        </div>
      </div>
    )
  }

  if (mode === 'measure' && !imageSize) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin" style={{ color: 'var(--color-purple)' }} />
        <span className="text-sm ml-3" style={{ color: 'var(--color-text-muted)' }}>Chargement...</span>
      </div>
    )
  }

  if (mode === 'measure' && imageSize) {
    const step = templeLine.length < 2 ? 'temple' : lensLine.length < 2 ? 'lens' : vertexLine.length < 2 ? 'vertex' : 'done'
    return (
      <div className="space-y-4 animate-fade-in">
        <div className="rounded-2xl border overflow-hidden relative" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
          <div className="relative select-none" style={{ touchAction: 'none' }}
            onPointerDown={handlePointerDown} onClick={handleImageClick}>
            <img src={imagePreview} alt="Profil" className="w-full aspect-[3/4] object-contain pointer-events-none" />
            {renderSegments()}
            {renderEndpoints(templeLine, '#f59e0b', 'temple')}
            {renderEndpoints(lensLine, '#8b5cf6', 'lens')}
            {/* Handles vertex discrets (6px, quasi invisibles) pour le drag */}
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
          {step === 'lens' && <>🟣 Placez 2 points sur le <strong>plan du verre</strong> ({lensLine.length}/2)</>}
          {step === 'vertex' && <>🟢 <strong>Segment vertex</strong> placé — ajustez cornée (gauche) et face arrière du verre (droite)</>}
          {step === 'done' && angleData && <>✅ Pantoscopique <strong>{angleData.pantoscopic}°</strong> | Vertex <strong>{vertexMm ? `${vertexMm} mm` : '...'}</strong></>}
        </div>

        {allAngleDone && angleData && (
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="py-2 rounded-xl" style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}>
              <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Branche</div>
              <div className="text-lg font-semibold" style={{ color: '#f59e0b' }}>{angleData.templeDeg}°</div>
            </div>
            <div className="py-2 rounded-xl" style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}>
              <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Plan verre</div>
              <div className="text-lg font-semibold" style={{ color: '#8b5cf6' }}>{angleData.lensDeg}°</div>
            </div>
            <div className="py-2 rounded-xl" style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}>
              <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Pantoscopique</div>
              <div className="text-lg font-semibold" style={{ color: 'var(--color-purple)' }}>{angleData.pantoscopic}°</div>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={resetAll} className="flex-1 py-2.5 rounded-full text-sm font-medium"
            style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>Annuler</button>
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

  // Écran de sélection
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-1 h-8 rounded-full" style={{ background: 'linear-gradient(var(--color-purple), var(--color-purple-light))' }} />
        <div>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text)', fontFamily: "'Playfair Display', Georgia, serif" }}>
            Photo de Profil (côté DROIT)
          </h2>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Angle pantoscopique & distance vertex</p>
        </div>
      </div>

      <div className="rounded-2xl border overflow-hidden cursor-pointer transition-all hover:border-[var(--color-gold)]"
        style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
        onClick={() => setMode('camera')}>
        <div className="flex flex-col items-center py-10 px-6"><Camera size={28} style={{ color: 'var(--color-gold)', marginBottom: 10 }} />
          <p className="text-base font-medium" style={{ color: 'var(--color-text)' }}>Prendre une photo</p></div>
      </div>
      <div className="rounded-2xl border overflow-hidden cursor-pointer transition-all hover:border-[var(--color-gold)]"
        style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
        onClick={() => setMode('upload')}>
        <div className="flex flex-col items-center py-10 px-6"><Upload size={28} style={{ color: 'var(--color-purple)', marginBottom: 10 }} />
          <p className="text-base font-medium" style={{ color: 'var(--color-text)' }}>Télécharger une photo</p></div>
      </div>
      <button onClick={onSkip} className="w-full py-2.5 rounded-full text-sm font-medium"
        style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>Passer</button>
    </div>
  )
}
