import { useState, useRef, useCallback, useEffect } from 'react'

/**
 * MeasureRuler — Réglette métrologique déplaçable (réutilisable, contrôlée).
 *
 * Design validé (maquette v1-v5) :
 *  - 100 mm réels, graduations 0.5 mm / 1 mm / 5 mm / cm chiffrés.
 *  - Rotation libre par une poignée compacte au CENTRE (+ snaps 0/45/90).
 *  - 2 lignes de lecture (index A doré, B bleu) déplaçables → écart en mm.
 *  - Badge écart TANGENT EN DESSOUS (n'occulte ni graduations ni index).
 *
 * Métrologie : longueur = 100mm dérivée de scaleMmPerPx et du recadrage
 * (displayRect vs imageSize). Graduations exactes, pas de facteur empirique.
 *
 * Deux rôles via props (composant contrôlé, état `visible` détenu par le parent) :
 *  - variant="button" → n'affiche que le bouton toggle.
 *  - variant="ruler"  → n'affiche que la réglette dans la zone image.
 * NB : on rend le bouton et la réglette dans un seul composant, ou on n'en rend qu'un.
 */

const MM_TOTAL = 100        // longueur (mm)
const STEP = 0.5            // précision graduation (mm)
const BAR_H = 46            // hauteur barre (px)
const SNAP_ANGLES = [0, 45, 90]

export default function MeasureRuler({ scaleMmPerPx, imageSize, displayRect, visible, onToggle, variant = 'button' })
{
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [angle, setAngle] = useState(0)
  const [idxA, setIdxA] = useState(0.35)
  const [idxB, setIdxB] = useState(0.65)
  const [warn, setWarn] = useState(false)
  const rulerRef = useRef(null)
  const drag = useRef(null)

  const enabled = !!scaleMmPerPx && !!imageSize && !!displayRect

  const lengthPx = useCallback(() => {
    if (!enabled) return 0
    return (MM_TOTAL / scaleMmPerPx) * (displayRect.width / imageSize.width)
  }, [enabled, scaleMmPerPx, displayRect, imageSize])

  const usableLength = enabled ? lengthPx() : 0
  const pxPerMm = enabled ? (usableLength / MM_TOTAL) : 0

  // Centrer la réglette à l'affichage (une seule fois par apparition)
  useEffect(() => {
    if (variant === 'ruler' && visible && enabled) {
      const L = lengthPx()
      setPos({
        x: Math.max(0, (displayRect.width - L) / 2),
        y: Math.max(0, displayRect.height / 2 - BAR_H / 2),
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, visible, enabled])

  // ── Drag handlers (références stables via useRef pour les valeurs lues) ──
  const stateRef = useRef({ pos, angle, idxA, idxB, usableLength, displayRect, enabled })
  stateRef.current = { pos, angle, idxA, idxB, usableLength, displayRect, enabled }

  const beginDrag = useCallback((e) => {
    if (!stateRef.current.enabled) return
    const idx = e.target.closest?.('[data-idx]')
    const isRot = e.target.closest?.('.mr-rot')
    const S = stateRef.current
    // Centre réel de la réglette (fiabble même en rotation) pour un angle de départ stable
    let startPtrAngle = 0
    if (isRot && rulerRef.current) {
      const rect = rulerRef.current.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      startPtrAngle = Math.atan2(e.clientY - cy, e.clientX - cx)
    }
    drag.current = {
      mode: idx ? idx.dataset.idx : isRot ? 'rot' : 'move',
      startX: e.clientX, startY: e.clientY,
      origX: S.pos.x, origY: S.pos.y,
      origA: S.angle,
      startPtrAngle,
      origIdxA: S.idxA, origIdxB: S.idxB,
    }
    e.preventDefault()
  }, [])

  const moveDrag = useCallback((e) => {
    const d = drag.current
    if (!d || !stateRef.current.enabled || !rulerRef.current) return
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY
    const S = stateRef.current
    if (d.mode === 'move') {
      setPos({
        x: Math.max(-S.usableLength * 0.15, Math.min(S.displayRect.width - S.usableLength * 0.85, d.origX + dx)),
        y: Math.max(-BAR_H * 0.15, Math.min(S.displayRect.height - BAR_H * 0.85, d.origY + dy)),
      })
    } else if (d.mode === 'rot') {
      // DELTA d'angle par rapport au départ → rotation fluide et stable, pas de saut
      const rect = rulerRef.current.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const curAngle = Math.atan2(e.clientY - cy, e.clientX - cx)
      const deltaDeg = (curAngle - d.startPtrAngle) * 180 / Math.PI
      setAngle(d.origA + deltaDeg)
    } else if (d.mode === 'a' || d.mode === 'b') {
      // Projection du déplacement sur l'Axe de la réglette (juste même en rotation)
      const rad = S.angle * Math.PI / 180
      const proj = dx * Math.cos(rad) + dy * Math.sin(rad)
      const stepPct = (proj / S.usableLength) * 100
      if (d.mode === 'a') setIdxA(Math.max(0, Math.min(100, d.origIdxA + stepPct)))
      else setIdxB(Math.max(0, Math.min(100, d.origIdxB + stepPct)))
    }
  }, [])

  const endDrag = useCallback(() => { drag.current = null }, [])

  // Attacher les listeners globaux seulement en mode ruler
  useEffect(() => {
    if (variant !== 'ruler') return
    window.addEventListener('pointermove', moveDrag)
    window.addEventListener('pointerup', endDrag)
    return () => {
      window.removeEventListener('pointermove', moveDrag)
      window.removeEventListener('pointerup', endDrag)
    }
  }, [variant, moveDrag, endDrag])

  // ── Bouton seul (variant="button") ──
  if (variant === 'button') {
    if (!enabled) {
      return (
        <button onClick={() => setWarn(true)}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
          style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
          📏 Réglette
          {warn && <span className="text-[10px]" style={{ color: 'var(--color-gold)' }}>· calibrez d'abord</span>}
        </button>
      )
    }
    return (
      <button onClick={onToggle}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
        style={visible
          ? { background: 'var(--color-gold)', color: 'var(--color-bg)' }
          : { background: 'var(--color-card)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
        📏 Réglette {visible ? '· masquer' : ''}
      </button>
    )
  }

  // ── Réglette (variant="ruler") ──
  if (variant === 'ruler' && (!visible || !enabled)) return null

  // Graduations
  const ticks = []
  if (enabled && usableLength) {
    for (let mm = 0; mm <= MM_TOTAL; mm += STEP) {
      const x = mm * pxPerMm
      const isCm = mm % 10 === 0, is5 = mm % 5 === 0, is1 = mm % 1 === 0
      let h, w, c
      if (isCm) { h = 24; w = 1.6; c = '#e8c06a' }
      else if (is5) { h = 18; w = 1.2; c = '#cfa85f' }
      else if (is1) { h = 13; w = 0.9; c = '#9a9aa0' }
      else { h = 9; w = 0.6; c = '#70707a' }
      ticks.push(<line key={mm} x1={x} y1={BAR_H - h} x2={x} y2={BAR_H} stroke={c} strokeWidth={w} />)
      if (isCm) {
        ticks.push(
          <text key={`t${mm}`} x={x} y={BAR_H - 27} fontSize="11" fontFamily="monospace"
            fill="#e8c06a" textAnchor="middle" fontWeight="700"
            style={{ textShadow: '0 1px 2px #000' }}>{mm}</text>
        )
      }
    }
  }

  const diffMm = enabled ? Math.abs(idxA - idxB) / 100 * MM_TOTAL : 0
  const mmA = (idxA / 100) * MM_TOTAL
  const mmB = (idxB / 100) * MM_TOTAL

  return (
    <div
      ref={rulerRef}
      className="mr-ruler"
      onPointerDown={beginDrag}
      style={{
        position: 'absolute', left: pos.x, top: pos.y,
        transform: `rotate(${angle}deg)`, transformOrigin: 'center',
        width: usableLength, height: BAR_H,
        cursor: 'grab', touchAction: 'none', userSelect: 'none',
        zIndex: 20, pointerEvents: 'auto',
      }}
    >
      <svg width={usableLength} height={BAR_H} viewBox={`0 0 ${usableLength} ${BAR_H}`}
        style={{ display: 'block', overflow: 'visible', filter: 'drop-shadow(0 2px 6px rgba(0,0,0,.5))' }}>
        <rect x="0" y="0" width={usableLength} height={BAR_H} rx="7"
          fill="rgba(12,12,16,0.55)" stroke="rgba(201,160,90,0.75)" strokeWidth="1.2" />
        {ticks}
      </svg>

      {/* index A (doré) */}
      <div data-idx="a" className="mr-index" style={{ left: `${idxA}%`, top: -6, transform: 'translateX(-50%)' }}>
        <span className="mr-index-tag a" style={{ top: -18, left: '50%', transform: 'translateX(-50%)' }}>{mmA.toFixed(1)}</span>
        <span className="mr-index-tick a" />
      </div>

      {/* index B (bleu) */}
      <div data-idx="b" className="mr-index" style={{ left: `${idxB}%`, top: -6, transform: 'translateX(-50%)' }}>
        <span className="mr-index-tag b" style={{ top: -18, left: '50%', transform: 'translateX(-50%)' }}>{mmB.toFixed(1)}</span>
        <span className="mr-index-tick b" />
      </div>

      {/* poignée de rotation (centre, compacte) */}
      <div className="mr-rot" style={{ left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }} />

      {/* badge écart — sous la réglette */}
      <div className="mr-diff" style={{ left: '50%', top: BAR_H + 6, transform: 'translateX(-50%)' }}>
        Δ {diffMm.toFixed(1)} mm
      </div>

      {/* snaps — sur le côté droit (colonne), hors de la zone de lecture */}
      <div className="mr-snaps" style={{ right: -34, top: '50%', transform: 'translateY(-50%)' }}>
        {SNAP_ANGLES.map(a => (
          <button key={a} onClick={(e) => { e.stopPropagation(); setAngle(a) }}>{a}°</button>
        ))}
      </div>
    </div>
  )
}
