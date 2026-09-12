import { useState, useRef, useCallback, useEffect } from 'react'
import { formatInclination } from '../core/rulerAngle'

/**
 * MeasureRuler — Réglette métrologique déplaçable (réutilisable, contrôlée).
 *
 * Design validé (maquette v1-v5) :
 *  - 100 mm réels, graduations 0.5 mm / 1 mm / 5 mm / cm chiffrés.
 *  - ROTATION À DEUX DOIGTS : l'angle est celui du VECTEUR entre les 2 doigts.
 *    La poignée centrale 1-doigt a été retirée — sur iPad un doigt masquait le
 *    centre et le levier de 15 px rendait la rotation imprécise.
 *  - INCLINAISON affichée dans le SEUL badge sous la réglette, à côté du Δ
 *    (valeur + « ° », couleur distincte, sans libellé) — remplace les anciens
 *    angles prédéfinis 0°/45°/90° et évite tout recouvrement entre badges.
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

export default function MeasureRuler({ scaleMmPerPx, imageSize, displayRect, visible, onToggle, variant = 'button' })
{
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [angle, setAngle] = useState(0)
  const [idxA, setIdxA] = useState(35)
  const [idxB, setIdxB] = useState(65)
  const [warn, setWarn] = useState(false)
  const [hint, setHint] = useState(true)   // indice « 2 doigts » (disparaît au 1er geste / après 6 s)
  const rulerRef = useRef(null)
  const drag = useRef(null)
  const pointers = useRef(new Map())       // pointerId → { x, y } (multi-touch)

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

  // Indice « 2 doigts » : affiché au 1er affichage, masqué au 1er geste ou après 6 s
  useEffect(() => {
    if (variant !== 'ruler' || !visible) return
    setHint(true)
    const t = setTimeout(() => setHint(false), 6000)
    return () => clearTimeout(t)
  }, [variant, visible])

  // ── Drag handlers (références stables via useRef pour les valeurs lues) ──
  const stateRef = useRef({ pos, angle, idxA, idxB, usableLength, displayRect, enabled })
  stateRef.current = { pos, angle, idxA, idxB, usableLength, displayRect, enabled }

  /** Les 2 doigts, dans l'ordre stable de leur pointerId. */
  const twoPointers = () =>
    [...pointers.current.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)

  const beginDrag = useCallback((e) => {
    if (!stateRef.current.enabled) return
    pointers.current.set(e.pointerId ?? 0, { x: e.clientX, y: e.clientY })
    const S = stateRef.current

    // 2 doigts → ROTATION (angle du vecteur inter-doigts)
    if (pointers.current.size >= 2) {
      const [p1, p2] = twoPointers()
      drag.current = {
        mode: 'rot2',
        startVec: Math.atan2(p2.y - p1.y, p2.x - p1.x),
        origA: S.angle,
      }
      setHint(false)
      e.preventDefault()
      return
    }

    // 1 doigt → déplacement, ou drag d'un index de lecture
    const idx = e.target.closest?.('[data-idx]')
    drag.current = {
      mode: idx ? idx.dataset.idx : 'move',
      startX: e.clientX, startY: e.clientY,
      origX: S.pos.x, origY: S.pos.y,
      origA: S.angle,
      origIdxA: S.idxA, origIdxB: S.idxB,
    }
    e.preventDefault()
  }, [])

  const moveDrag = useCallback((e) => {
    const d = drag.current
    if (!d || !stateRef.current.enabled) return
    const S = stateRef.current
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }

    if (d.mode === 'rot2') {
      if (pointers.current.size < 2) return
      const [p1, p2] = twoPointers()
      const curVec = Math.atan2(p2.y - p1.y, p2.x - p1.x)
      // DELTA d'angle par rapport au départ → rotation fluide, pas de saut
      setAngle(d.origA + (curVec - d.startVec) * 180 / Math.PI)
      return
    }

    const dx = e.clientX - d.startX, dy = e.clientY - d.startY
    if (d.mode === 'move') {
      setPos({
        x: Math.max(-S.usableLength * 0.15, Math.min(S.displayRect.width - S.usableLength * 0.85, d.origX + dx)),
        y: Math.max(-BAR_H * 0.15, Math.min(S.displayRect.height - BAR_H * 0.85, d.origY + dy)),
      })
    } else if (d.mode === 'a' || d.mode === 'b') {
      // Projection du déplacement sur l'Axe de la réglette (juste même en rotation)
      const rad = S.angle * Math.PI / 180
      const proj = dx * Math.cos(rad) + dy * Math.sin(rad)
      const stepPct = (proj / S.usableLength) * 100
      if (d.mode === 'a') setIdxA(Math.max(0, Math.min(100, d.origIdxA + stepPct)))
      else setIdxB(Math.max(0, Math.min(100, d.origIdxB + stepPct)))
    }
  }, [])

  // Fin de geste : on retire le doigt levé. Dès qu'il reste MOINS de 2 doigts,
  // on clôt le geste pour qu'aucun mouvement résiduel ne fasse sauter l'angle.
  const endDrag = useCallback((e) => {
    if (e && e.pointerId != null) pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) drag.current = null
  }, [])

  // Attacher les listeners globaux seulement en mode ruler
  useEffect(() => {
    if (variant !== 'ruler') return
    window.addEventListener('pointermove', moveDrag)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    return () => {
      window.removeEventListener('pointermove', moveDrag)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
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

      {/* badge écart + inclinaison — UN SEUL badge sous la réglette.
          L'inclinaison par rapport à l'horizontale est affichée à côté du Δ,
          dans une couleur distincte et sans libellé (juste la valeur + « ° »).
          Un seul badge = plus aucun recouvrement possible entre eux. */}
      <div className="mr-diff" style={{ left: '50%', top: BAR_H + 6, transform: 'translateX(-50%)' }}>
        <span>Δ {diffMm.toFixed(1)} mm</span>
        <span className="mr-incl">{formatInclination(angle)}</span>
      </div>

      {/* indice de rotation (disparaît au 1er geste 2 doigts ou après 6 s) */}
      {hint && (
        <div className="mr-hint" style={{ left: '50%', top: -50, transform: 'translateX(-50%)' }}>
          🖐 2 doigts pour pivoter
        </div>
      )}
    </div>
  )
}
