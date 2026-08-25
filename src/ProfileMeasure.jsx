import { useState, useRef, useCallback, useEffect } from 'react'
import { ArrowLeft, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'
import { analyzeProfile } from './services/api'

/**
 * Mesures latérales (profil D) — étape séparée après la capture de la photo.
 * Reçoit la photo latérale DÉJÀ capturée + l'échelle de calibration.
 * Segments : temple 🟠, plan verre 🟣, vertex 🟢 (cornée ↔ face arrière verre).
 *
 * Détection auto : au chargement, /api/analyze-profile pré-place les 3 segments
 * (mires latérales → plan verre, Hough → branche, MediaPipe → cornée) ;
 * tout reste ajustable à la main.
 */
export default function ProfileMeasure({ imageUrl, calibrationScale, onCapture, onSkip, onBack }) {
  const [imageSize, setImageSize] = useState(null)
  const [error, setError] = useState(null)

  // Mesure manuelle
  const [templeLine, setTempleLine] = useState([])   // 2 points branche
  const [lensLine, setLensLine] = useState([])        // 2 points plan verre
  const [vertexLine, setVertexLine] = useState([])    // 2 points cornée→verre
  const dragRef = useRef(null)

  // ── Détection auto (backend /api/analyze-profile) ──
  const [autoStatus, setAutoStatus] = useState('idle') // idle | detecting | success | failed
  // Échelle de MESURE du profil : auto-calibrée sur les 25 mm entre les 2 mires
  // latérales (le backend la calcule toujours ainsi). L'échelle frontale ne sert
  // qu'à guider la détection — les 2 photos peuvent avoir des échelles différentes.
  const [profileScale, setProfileScale] = useState(null)
  const [scaleDeltaPct, setScaleDeltaPct] = useState(null) // écart % profil vs frontale
  const [scaleSource, setScaleSource] = useState('lateral_markers') // 'lateral_markers' | 'manual'
  const [lateralSpacingMm, setLateralSpacingMm] = useState(null) // 35 (design) ou 25 (legacy)
  const autoRunRef = useRef(false)
  const forceAutoRef = useRef(false)

  const clampSeg = useCallback((pts) => {
    if (!imageSize) return pts
    return pts.map(([x, y]) => ({
      x: Math.max(0, Math.min(imageSize.width, Math.round(x))),
      y: Math.max(0, Math.min(imageSize.height, Math.round(y))),
    }))
  }, [imageSize])

  const runAutoDetect = useCallback(async () => {
    if (!imageUrl || !imageSize || autoStatus === 'detecting') return
    setAutoStatus('detecting')
    try {
      const resp = await fetch(imageUrl)
      const blob = await resp.blob()
      const data = await analyzeProfile(blob, calibrationScale)

      // Plan du verre : le backend renvoie la ligne du plan du verre (⊥ au segment
      // des mires pour le design v3/v4, ou le segment lui-même pour l'ancien clip).
      if (data?.lens_line && data.lens_line.length === 2) {
        const lens = clampSeg(data.lens_line)
        setLensLine(prev => (forceAutoRef.current || prev.length === 0 ? lens : prev))
      } else if (data?.lateral_markers && data.lateral_markers.length === 2) {
        const lens = data.lateral_markers.map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) }))
        setLensLine(prev => (forceAutoRef.current || prev.length === 0 ? lens : prev))
      }
      // Branche : segment reconstruit depuis la charnière, à l'angle détecté
      if (data?.temple_line && data.temple_line.length === 2) {
        const temple = clampSeg(data.temple_line)
        setTempleLine(prev => (forceAutoRef.current || prev.length === 0 ? temple : prev))
      }
      // Vertex : cornée → face arrière du verre (calculé ensuite via /api/compute-vertex)
      if (data?.vertex_line && data.vertex_line.length === 2) {
        const vertex = clampSeg(data.vertex_line)
        setVertexLine(prev => (forceAutoRef.current || prev.length === 0 ? vertex : prev))
        vertexNeedsCompute.current = true
      }

      // Échelle de mesure : le backend l'auto-calibre sur les 25 mm entre les centres
      // des 2 mires latérales — c'est elle qui doit servir pour le vertex, pas celle
      // de la photo de face (distances de prise de vue potentiellement différentes).
      if (data?.scale_mm_per_px && data.scale_mm_per_px > 0) {
        setProfileScale(data.scale_mm_per_px)
      }
      if (data?.scale_delta_pct != null) {
        setScaleDeltaPct(data.scale_delta_pct)
        if (data?.scale_source) setScaleSource(data.scale_source)
      }
      if (data?.lateral_spacing_mm) {
        setLateralSpacingMm(data.lateral_spacing_mm)
      }

      forceAutoRef.current = false
      setAutoStatus('success')
    } catch (e) {
      console.warn('[ProfileMeasure] Analyse auto du profil indisponible:', e.message)
      forceAutoRef.current = false
      setAutoStatus('failed')
    }
  }, [imageUrl, imageSize, calibrationScale, autoStatus, clampSeg])

  // Lancement unique dès que l'image est dimensionnée
  useEffect(() => {
    if (!imageSize || autoRunRef.current) return
    autoRunRef.current = true
    runAutoDetect()
  }, [imageSize, runAutoDetect])

  const handleAutoDetect = useCallback(() => {
    forceAutoRef.current = true // remplace les segments existants
    runAutoDetect()
  }, [runAutoDetect])

  // ── Chargement de l'image déjà capturée ──
  useEffect(() => {
    const img = new Image()
    img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => setError('Image de profil illisible')
    img.src = imageUrl
  }, [imageUrl])

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
    // Priorité : échelle auto-calibrée du profil (25 mm entre mires) → sinon échelle frontale
    const scale = profileScale || calibrationScale
    if (vertexLine.length < 2 || !scale) return
    setVertexLoading(true)
    try {
      const res = await fetch('/api/compute-vertex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cornea_x: vertexLine[0].x, cornea_y: vertexLine[0].y,
          lens_back_x: vertexLine[1].x, lens_back_y: vertexLine[1].y,
          scale_mm_per_px: scale,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setVertexMm(data.vertex_distance_mm)
      }
    } catch { /* silencieux */ }
    setVertexLoading(false)
  }, [vertexLine, calibrationScale, profileScale])

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

  // ── Vérification du calibrage 25 mm ──
  // L'utilisateur place 2 points (reliés par une droite) sur les 2 cercles noirs
  // latéraux du clip : la distance mesurée doit valoir ~25 mm avec l'échelle active.
  const [verifyActive, setVerifyActive] = useState(false)
  const [verifyLine, setVerifyLine] = useState([])   // 2 points

  const verifyResult = (() => {
    if (verifyLine.length < 2) return null
    const scale = profileScale || calibrationScale
    const d = Math.hypot(verifyLine[1].x - verifyLine[0].x, verifyLine[1].y - verifyLine[0].y)
    if (!scale || d === 0) return { px: Math.round(d), mm: null, delta: null, scale: null, impliedScale: null }
    const mm = d * scale
    return {
      px: Math.round(d),
      mm: Math.round(mm * 10) / 10,
      delta: Math.round((mm - 25) * 10) / 10,
      scale,
      impliedScale: Math.round(25 / d * 10000) / 10000,
    }
  })()

  const toggleVerify = useCallback(() => {
    setVerifyActive(v => {
      const next = !v
      if (next) setVerifyLine([])
      return next
    })
  }, [])

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
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (wasVertex) vertexNeedsCompute.current = true
    }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp)
  }, [imageSize])

  // ── Clic pour placer temple/lens (ou les points de vérification) ──
  const handleImageClick = useCallback((e) => {
    if (!imageSize) return
    if (e.target.closest('[data-seg-type]')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pt = { x: Math.round((e.clientX - rect.left) / rect.width * imageSize.width), y: Math.round((e.clientY - rect.top) / rect.height * imageSize.height) }
    if (verifyActive) {
      if (verifyLine.length < 2) setVerifyLine(prev => [...prev, pt])
      return
    }
    if (templeLine.length < 2) setTempleLine(prev => [...prev, pt])
    else if (lensLine.length < 2) setLensLine(prev => [...prev, pt])
  }, [imageSize, templeLine, lensLine, verifyActive, verifyLine.length])

  // ── Reset ──
  const resetMeasure = useCallback(() => { setTempleLine([]); setLensLine([]); setVertexLine([]); setVertexMm(null); setVerifyLine([]) }, [])

  // ── Validation ──
  const confirm = useCallback(() => {
    onCapture({
      width: imageSize?.width || 0, height: imageSize?.height || 0,
      lateral_markers: [[lensLine[0].x, lensLine[0].y], [lensLine[1].x, lensLine[1].y]],
      temple_markers: [[templeLine[0].x, templeLine[0].y], [templeLine[1].x, templeLine[1].y]],
      vertex_markers: vertexLine.length === 2 ? [[vertexLine[0].x, vertexLine[0].y], [vertexLine[1].x, vertexLine[1].y]] : null,
      pantoscopic_angle: angleData?.pantoscopic || 0,
      vertex_distance: vertexMm,
      manual: true, face_detected: false,
      scale_mm_per_px: profileScale || calibrationScale || 0,
    })
  }, [imageSize, lensLine, templeLine, vertexLine, angleData, vertexMm, calibrationScale, profileScale, onCapture])

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
        {verifyLine.length >= 2 && (() => {
          const [p1, p2] = verifyLine
          const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2
          const label = verifyResult?.mm != null ? `${verifyResult.mm} mm` : '25 mm ?'
          return (
            <>
              <line x1={toPct(p1.x, imageSize.width)} y1={toPct(p1.y, imageSize.height)}
                x2={toPct(p2.x, imageSize.width)} y2={toPct(p2.y, imageSize.height)}
                stroke="#22d3ee" strokeWidth="2.5" strokeLinecap="round" opacity="0.95" />
              <text x={toPct(mx, imageSize.width)} y={toPct(my, imageSize.height)}
                fontSize="11" fontWeight="700" fill="#22d3ee" textAnchor="middle"
                dominantBaseline="middle"
                style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.9))', pointerEvents: 'none' }}>
                {label}
              </text>
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

      {/* Détection auto du profil (backend /api/analyze-profile) */}
      {autoStatus === 'detecting' && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
          style={{ background: 'var(--color-purple-bg)', color: 'var(--color-purple)', border: '1px solid rgba(139,92,246,0.25)' }}>
          <Loader2 size={14} className="animate-spin" />
          <span className="flex-1">Analyse automatique du profil en cours…</span>
        </div>
      )}
      {autoStatus === 'success' && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
          style={{ background: 'var(--color-green-bg)', color: 'var(--color-green)', border: '1px solid rgba(34,197,94,0.25)' }}>
          <CheckCircle2 size={14} />
          <span className="flex-1">Repères détectés automatiquement — ajustez si besoin</span>
          <button onClick={handleAutoDetect} className="shrink-0 underline decoration-dotted hover:opacity-80">↻ Relancer</button>
        </div>
      )}
      {autoStatus === 'failed' && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
          style={{ background: 'var(--color-red-bg)', color: 'var(--color-red)', border: '1px solid rgba(255,107,107,0.25)' }}>
          <AlertTriangle size={14} />
          <span className="flex-1">Détection auto impossible — placement manuel</span>
          <button onClick={handleAutoDetect} className="shrink-0 underline decoration-dotted hover:opacity-80">↻ Réessayer</button>
        </div>
      )}

      {/* Échelle de mesure du profil — auto-calibrée ou manuelle (règle métrologique) */}
      {autoStatus === 'success' && profileScale && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
          style={{ background: 'rgba(201,160,90,0.08)', color: 'var(--color-gold)', border: '1px solid rgba(201,160,90,0.2)' }}>
          <span className="flex-1">
            Échelle du profil : <strong>1 px = {Math.round(profileScale * 1000) / 1000} mm</strong>{' '}
            {scaleSource === 'manual'
              ? '(échelle MANUELLE — détection latérale non fiable, calibration frontale utilisée)'
              : `(auto-calibrée sur le segment de ${lateralSpacingMm ?? 25} mm entre les 2 mires)`}
          </span>
        </div>
      )}
      {autoStatus === 'success' && scaleDeltaPct != null && scaleDeltaPct > 15 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
          style={{ background: 'var(--color-red-bg)', color: 'var(--color-red)', border: '1px solid rgba(255,107,107,0.25)' }}>
          <AlertTriangle size={14} />
          <span className="flex-1">
            ⚠️ Échelle auto {scaleDeltaPct}% ≠ échelle manuelle — l'échelle MANUELLE est utilisée
            pour la mesure (règle métrologique : la détection latérale est jugée non fiable).
          </span>
        </div>
      )}

      {/* Vérification du calibrage 25 mm (2 points sur les cercles noirs latéraux) */}
      <div className="flex items-center justify-between gap-2">
        <button onClick={toggleVerify}
          className="flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-medium transition-all hover:opacity-90"
          style={{
            background: verifyActive ? 'rgba(34,211,238,0.15)' : 'var(--color-border)',
            color: verifyActive ? '#22d3ee' : 'var(--color-text-muted)',
            border: verifyActive ? '1.5px solid #22d3ee' : '1.5px solid transparent',
          }}>
          {verifyActive ? '✕ Fermer la vérification' : '🔍 Vérifier le calibrage 25 mm'}
        </button>
        {verifyActive && verifyLine.length > 0 && (
          <button onClick={() => setVerifyLine([])} className="text-xs underline decoration-dotted hover:opacity-80"
            style={{ color: 'var(--color-text-muted)' }}>
            Recommencer
          </button>
        )}
      </div>

      {verifyActive && (
        <div className="rounded-xl px-4 py-3 text-xs border"
          style={{
            background: verifyResult && verifyResult.mm != null
              ? (Math.abs(verifyResult.delta) <= 1.5 ? 'var(--color-green-bg)'
                : Math.abs(verifyResult.delta) <= 3 ? 'rgba(201,160,90,0.12)' : 'var(--color-red-bg)')
              : 'var(--color-bg)',
            borderColor: verifyResult && verifyResult.mm != null
              ? (Math.abs(verifyResult.delta) <= 1.5 ? 'rgba(34,197,94,0.3)'
                : Math.abs(verifyResult.delta) <= 3 ? 'rgba(201,160,90,0.3)' : 'rgba(255,107,107,0.3)')
              : 'var(--color-border)',
          }}>
          {!verifyResult || verifyResult.mm == null ? (
            <span style={{ color: 'var(--color-text-muted)' }}>
              {verifyLine.length < 2
                ? 'Placez 2 points (reliés par une droite cyan) sur les 2 cercles noirs latéraux.'
                : 'Échelle indisponible — faites d’abord la calibration frontale.'}
            </span>
          ) : (
            (() => {
              const ok = Math.abs(verifyResult.delta) <= 1.5
              const warn = Math.abs(verifyResult.delta) <= 3
              const color = ok ? 'var(--color-green)' : warn ? 'var(--color-gold)' : 'var(--color-red)'
              return (
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>Distance mesurée (25 mm attendus)</span>
                    <span className="font-bold" style={{ color }}>
                      {verifyResult.mm} mm{verifyResult.delta !== 0 && ` (${verifyResult.delta > 0 ? '+' : ''}${verifyResult.delta})`}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>Calcul</span>
                    <span style={{ color: 'var(--color-text-dim)' }}>
                      {verifyResult.px} px × {verifyResult.scale.toFixed(4)} mm/px
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--color-text-muted)' }}>Échelle impliquée par ta mesure</span>
                    <span style={{ color: '#22d3ee' }}>1 px = {verifyResult.impliedScale} mm</span>
                  </div>
                  <div style={{ color }}>
                    {ok ? '✅ Calibrage conforme (±1.5 mm)' : warn ? '⚠️ Calibrage approximatif — vérifiez le placement' : '❌ Calibrage incohérent — échelle ou placement à revoir'}
                  </div>
                </div>
              )
            })()
          )}
        </div>
      )}

      <div className="rounded-2xl border overflow-hidden relative" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
        <div className="relative select-none" style={{ touchAction: 'none' }}
          onPointerDown={handlePointerDown} onClick={handleImageClick}>
          <img src={imageUrl} alt="Profil" className="w-full aspect-[3/4] object-contain pointer-events-none" />
          {renderSegments()}
          {renderEndpoints(templeLine, '#f59e0b', 'temple')}
          {renderEndpoints(lensLine, '#8b5cf6', 'lens')}
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
        {step === 'lens' && <>🟣 Placez 2 points sur le <strong>plan du verre</strong> ({lensLine.length}/2)</>}
        {step === 'vertex' && <>🟢 <strong>Segment vertex</strong> placé — ajustez cornée (gauche) et face arrière du verre (droite)</>}
        {step === 'done' && angleData && <>✅ Pantoscopique <strong>{angleData.pantoscopic}°</strong> | Vertex <strong>{vertexLoading ? '...' : vertexMm ? `${vertexMm} mm` : '—'}</strong></>}
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
