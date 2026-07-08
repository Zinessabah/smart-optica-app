import { useState, useCallback } from 'react'

/**
 * Boxing rectangle — resizable with professional optical-style graphics.
 *
 * Features:
 * - Double-outline with corner brackets (optical industry style)
 * - Semi-transparent overlay outside the box (focus area)
 * - Diamond resize handles
 * - Cross-arrows move handle
 * - Live dimension annotation on active edge
 */
export default function BoxingRect({
  rect, imageSize, toImageCoords, onChange, active, color, label, containerRef
}) {
  const [drag, setDrag] = useState(null)
  const [hoveredHandle, setHoveredHandle] = useState(null)

  const handlePointerDown = useCallback((mode, e) => {
    e.stopPropagation()
    e.preventDefault()
    e.target.setPointerCapture(e.pointerId)
    setDrag({ mode, startClient: { x: e.clientX, y: e.clientY }, startRect: { ...rect } })
  }, [rect])

  const handleClick = useCallback((e) => { e.stopPropagation() }, [])

  const handlePointerMove = useCallback((e) => {
    if (!drag) return
    const startImg = toImageCoords(drag.startClient.x, drag.startClient.y)
    const currImg = toImageCoords(e.clientX, e.clientY)
    if (!startImg || !currImg) return
    const dx = currImg.x - startImg.x
    const dy = currImg.y - startImg.y
    const minSize = 15
    const sr = drag.startRect
    let newRect = { x: sr.x, y: sr.y, width: sr.width, height: sr.height }

    switch (drag.mode) {
      case 'move':
        newRect.x = sr.x + dx; newRect.y = sr.y + dy; break
      case 'nw': {
        const seX = sr.x + sr.width / 2, seY = sr.y + sr.height / 2
        const nwX = sr.x - sr.width / 2 + dx, nwY = sr.y - sr.height / 2 + dy
        newRect.width = Math.max(minSize, seX - nwX); newRect.height = Math.max(minSize, seY - nwY)
        newRect.x = (nwX + seX) / 2; newRect.y = (nwY + seY) / 2; break
      }
      case 'ne': {
        const swX = sr.x - sr.width / 2, swY = sr.y + sr.height / 2
        const neX = sr.x + sr.width / 2 + dx, neY = sr.y - sr.height / 2 + dy
        newRect.width = Math.max(minSize, neX - swX); newRect.height = Math.max(minSize, swY - neY)
        newRect.x = (swX + neX) / 2; newRect.y = (neY + swY) / 2; break
      }
      case 'sw': {
        const neX = sr.x + sr.width / 2, neY = sr.y - sr.height / 2
        const swX = sr.x - sr.width / 2 + dx, swY = sr.y + sr.height / 2 + dy
        newRect.width = Math.max(minSize, neX - swX); newRect.height = Math.max(minSize, swY - neY)
        newRect.x = (swX + neX) / 2; newRect.y = (neY + swY) / 2; break
      }
      case 'se': {
        const nwX = sr.x - sr.width / 2, nwY = sr.y - sr.height / 2
        const seX = sr.x + sr.width / 2 + dx, seY = sr.y + sr.height / 2 + dy
        newRect.width = Math.max(minSize, seX - nwX); newRect.height = Math.max(minSize, seY - nwY)
        newRect.x = (nwX + seX) / 2; newRect.y = (nwY + seY) / 2; break
      }
      case 'n': {
        const bottom = sr.y + sr.height / 2, top = sr.y - sr.height / 2 + dy
        newRect.height = Math.max(minSize, bottom - top); newRect.y = (top + bottom) / 2; break
      }
      case 's': {
        const top = sr.y - sr.height / 2, bottom = sr.y + sr.height / 2 + dy
        newRect.height = Math.max(minSize, bottom - top); newRect.y = (top + bottom) / 2; break
      }
      case 'w': {
        const right = sr.x + sr.width / 2, left = sr.x - sr.width / 2 + dx
        newRect.width = Math.max(minSize, right - left); newRect.x = (left + right) / 2; break
      }
      case 'e': {
        const left = sr.x - sr.width / 2, right = sr.x + sr.width / 2 + dx
        newRect.width = Math.max(minSize, right - left); newRect.x = (left + right) / 2; break
      }
    }
    onChange(newRect)
  }, [drag, toImageCoords, onChange])

  const handlePointerUp = useCallback((e) => {
    e.target.releasePointerCapture(e.pointerId)
    setDrag(null)
  }, [])

  if (!rect || !imageSize) return null

  const getDisplayRect = () => {
    if (!containerRef?.current || !imageSize) return null
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

  const dr = getDisplayRect()
  if (!dr) return null

  const cw = containerRef.current?.getBoundingClientRect()?.width || 1
  const ch = containerRef.current?.getBoundingClientRect()?.height || 1

  const toPctX = (px) => ((dr.left + (px / imageSize.width) * dr.width) / cw) * 100
  const toPctY = (py) => ((dr.top + (py / imageSize.height) * dr.height) / ch) * 100
  const toPctW = (pw) => ((pw / imageSize.width) * dr.width / cw) * 100
  const toPctH = (ph) => ((ph / imageSize.height) * dr.height / ch) * 100

  const left = rect.x - rect.width / 2
  const top = rect.y - rect.height / 2

  const boxLeftPct = toPctX(left)
  const boxTopPct = toPctY(top)
  const boxWidthPct = toPctW(rect.width)
  const boxHeightPct = toPctH(rect.height)

  // Corner bracket size (percentage of box)
  const bracketLen = Math.min(boxWidthPct, boxHeightPct) * 0.25
  const bracketMax = 8 // % max

  // Half-sides : show thin line along edges, thicker at corners
  const lineColor = color
  const cornerColor = color

  const handles = {
    nw: { left: boxLeftPct, top: boxTopPct, cursor: 'nw-resize' },
    n:  { left: boxLeftPct + boxWidthPct / 2, top: boxTopPct, cursor: 'n-resize' },
    ne: { left: boxLeftPct + boxWidthPct, top: boxTopPct, cursor: 'ne-resize' },
    e:  { left: boxLeftPct + boxWidthPct, top: boxTopPct + boxHeightPct / 2, cursor: 'e-resize' },
    se: { left: boxLeftPct + boxWidthPct, top: boxTopPct + boxHeightPct, cursor: 'se-resize' },
    s:  { left: boxLeftPct + boxWidthPct / 2, top: boxTopPct + boxHeightPct, cursor: 's-resize' },
    sw: { left: boxLeftPct, top: boxTopPct + boxHeightPct, cursor: 'sw-resize' },
    w:  { left: boxLeftPct, top: boxTopPct + boxHeightPct / 2, cursor: 'w-resize' },
  }

  // Corner bracket SVG: draw corner brackets at each corner
  const cornerBrackets = []
  const bk = Math.min(bracketLen, bracketMax)
  const inset = 0 // bracket starts at edge

  // Top-left
  cornerBrackets.push(
    <line key="tl-h" x1={`${boxLeftPct}%`} y1={`${boxTopPct + bk}%`}
      x2={`${boxLeftPct}%`} y2={`${boxTopPct}%`}
      stroke={cornerColor} strokeWidth="2.5" opacity="0.9" />,
    <line key="tl-v" x1={`${boxLeftPct}%`} y1={`${boxTopPct}%`}
      x2={`${boxLeftPct + bk}%`} y2={`${boxTopPct}%`}
      stroke={cornerColor} strokeWidth="2.5" opacity="0.9" />
  )
  // Top-right
  cornerBrackets.push(
    <line key="tr-h" x1={`${boxLeftPct + boxWidthPct}%`} y1={`${boxTopPct + bk}%`}
      x2={`${boxLeftPct + boxWidthPct}%`} y2={`${boxTopPct}%`}
      stroke={cornerColor} strokeWidth="2.5" opacity="0.9" />,
    <line key="tr-v" x1={`${boxLeftPct + boxWidthPct - bk}%`} y1={`${boxTopPct}%`}
      x2={`${boxLeftPct + boxWidthPct}%`} y2={`${boxTopPct}%`}
      stroke={cornerColor} strokeWidth="2.5" opacity="0.9" />
  )
  // Bottom-left
  cornerBrackets.push(
    <line key="bl-h" x1={`${boxLeftPct}%`} y1={`${boxTopPct + boxHeightPct - bk}%`}
      x2={`${boxLeftPct}%`} y2={`${boxTopPct + boxHeightPct}%`}
      stroke={cornerColor} strokeWidth="2.5" opacity="0.9" />,
    <line key="bl-v" x1={`${boxLeftPct}%`} y1={`${boxTopPct + boxHeightPct}%`}
      x2={`${boxLeftPct + bk}%`} y2={`${boxTopPct + boxHeightPct}%`}
      stroke={cornerColor} strokeWidth="2.5" opacity="0.9" />
  )
  // Bottom-right
  cornerBrackets.push(
    <line key="br-h" x1={`${boxLeftPct + boxWidthPct}%`} y1={`${boxTopPct + boxHeightPct - bk}%`}
      x2={`${boxLeftPct + boxWidthPct}%`} y2={`${boxTopPct + boxHeightPct}%`}
      stroke={cornerColor} strokeWidth="2.5" opacity="0.9" />,
    <line key="br-v" x1={`${boxLeftPct + boxWidthPct - bk}%`} y1={`${boxTopPct + boxHeightPct}%`}
      x2={`${boxLeftPct + boxWidthPct}%`} y2={`${boxTopPct + boxHeightPct}%`}
      stroke={cornerColor} strokeWidth="2.5" opacity="0.9" />
  )

  return (
    <>
      {/* Outside dim overlay — highlights the measurement area */}
      {active && (
        <div className="absolute pointer-events-none" style={{
          left: 0, top: 0, width: '100%', height: '100%',
          zIndex: 11,
        }}>
          {/* Top strip */}
          <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: `${boxTopPct}%`, background: 'rgba(0,0,0,0.35)' }} />
          {/* Bottom strip */}
          <div style={{ position: 'absolute', left: 0, top: `${boxTopPct + boxHeightPct}%`, width: '100%', height: `${100 - boxTopPct - boxHeightPct}%`, background: 'rgba(0,0,0,0.35)' }} />
          {/* Left strip */}
          <div style={{ position: 'absolute', left: 0, top: `${boxTopPct}%`, width: `${boxLeftPct}%`, height: `${boxHeightPct}%`, background: 'rgba(0,0,0,0.35)' }} />
          {/* Right strip */}
          <div style={{ position: 'absolute', left: `${boxLeftPct + boxWidthPct}%`, top: `${boxTopPct}%`, width: `${100 - boxLeftPct - boxWidthPct}%`, height: `${boxHeightPct}%`, background: 'rgba(0,0,0,0.35)' }} />
        </div>
      )}

      {/* Dotted edge line (midline of each side) */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 12 }}>
        {/* Top edge thin dots */}
        <line x1={`${boxLeftPct + 2}%`} y1={`${boxTopPct}%`}
          x2={`${boxLeftPct + boxWidthPct - 2}%`} y2={`${boxTopPct}%`}
          stroke={`${lineColor}50`} strokeWidth="1" strokeDasharray="3 4" />
        {/* Bottom edge thin dots */}
        <line x1={`${boxLeftPct + 2}%`} y1={`${boxTopPct + boxHeightPct}%`}
          x2={`${boxLeftPct + boxWidthPct - 2}%`} y2={`${boxTopPct + boxHeightPct}%`}
          stroke={`${lineColor}50`} strokeWidth="1" strokeDasharray="3 4" />
        {/* Left edge thin dots */}
        <line x1={`${boxLeftPct}%`} y1={`${boxTopPct + 2}%`}
          x2={`${boxLeftPct}%`} y2={`${boxTopPct + boxHeightPct - 2}%`}
          stroke={`${lineColor}50`} strokeWidth="1" strokeDasharray="3 4" />
        {/* Right edge thin dots */}
        <line x1={`${boxLeftPct + boxWidthPct}%`} y1={`${boxTopPct + 2}%`}
          x2={`${boxLeftPct + boxWidthPct}%`} y2={`${boxTopPct + boxHeightPct - 2}%`}
          stroke={`${lineColor}50`} strokeWidth="1" strokeDasharray="3 4" />

        {/* Corner brackets */}
        {active && cornerBrackets}
      </svg>

      {/* Move handle — cross-arrows diamond */}
      {active && (
        <div className="absolute cursor-move" style={{
          left: `${boxLeftPct + boxWidthPct / 2}%`, top: `${boxTopPct + boxHeightPct / 2}%`,
          transform: 'translate(-50%, -50%)', zIndex: 22,
        }}
          onPointerDown={(e) => handlePointerDown('move', e)}
          onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onClick={handleClick}>
          <svg width="20" height="20" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="9" fill={`${color}22`} stroke={color} strokeWidth="1.5" />
            <path d="M10 4 L12 8 L8 8 Z M10 16 L12 12 L8 12 Z M4 10 L8 8 L8 12 Z M16 10 L12 8 L12 12 Z"
              fill={color} opacity="0.8" />
            <circle cx="10" cy="10" r="2" fill={color} />
          </svg>
        </div>
      )}

      {/* Resize handles — diamond shaped */}
      {active && Object.entries(handles).map(([key, h]) => {
        const isHovered = hoveredHandle === key
        return (
          <div key={key} className="absolute" style={{
            left: `${h.left}%`, top: `${h.top}%`,
            transform: 'translate(-50%, -50%)',
            zIndex: 21,
            cursor: h.cursor,
          }}
            onPointerDown={(e) => handlePointerDown(key, e)}
            onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
            onClick={handleClick}
            onMouseEnter={() => setHoveredHandle(key)}
            onMouseLeave={() => setHoveredHandle(null)}>
            <svg width="14" height="14" viewBox="0 0 14 14"
              style={{ display: 'block', transition: 'transform 0.15s', transform: isHovered ? 'scale(1.3)' : 'scale(1)' }}>
              <rect x="2" y="2" width="10" height="10" rx="2" ry="2"
                fill={isHovered ? color : `${color}cc`}
                stroke="rgba(255,255,255,0.6)" strokeWidth="1"
                style={{ transition: 'fill 0.15s' }}
              />
              {/* Inner diamond accent */}
              <rect x="4.5" y="4.5" width="5" height="5" rx="1"
                fill="rgba(255,255,255,0.25)" />
            </svg>
          </div>
        )
      })}

      {/* Label badge */}
      <div className="absolute pointer-events-none" style={{
        left: `${boxLeftPct + boxWidthPct / 2}%`, top: `${boxTopPct}%`,
        transform: 'translate(-50%, -50%)', zIndex: 22,
      }}>
        <span className="text-[10px] font-semibold whitespace-nowrap px-2 py-0.5 rounded-full inline-flex items-center gap-1"
          style={{
            background: `${color}dd`,
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.3)',
            backdropFilter: 'blur(4px)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}>
          <svg width="8" height="8" viewBox="0 0 8 8">
            <rect x="1" y="1" width="6" height="6" rx="1" fill="none" stroke="#fff" strokeWidth="1" opacity="0.6" />
          </svg>
          {label}
        </span>
      </div>
    </>
  )
}
