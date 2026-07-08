import { useState, useCallback } from 'react'

/**
 * Boxing rectangle — 16 handles (2 per side + 4 corners), professional optical style.
 * Corner brackets + dotted midlines + outside dim overlay.
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

      // Corners
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

      // Top edge: left third, right third
      case 'nt-l': {
        const bottom = sr.y + sr.height / 2, top = sr.y - sr.height / 2 + dy
        newRect.height = Math.max(minSize, bottom - top); newRect.y = (top + bottom) / 2
        // also shift left side
        const right = sr.x + sr.width / 2, leftC = sr.x - sr.width / 2 + dx * 0.5
        if (right - leftC >= minSize) { newRect.width = right - leftC; newRect.x = (leftC + right) / 2 }
        break
      }
      case 'nt-r': {
        const bottom = sr.y + sr.height / 2, top = sr.y - sr.height / 2 + dy
        newRect.height = Math.max(minSize, bottom - top); newRect.y = (top + bottom) / 2
        const leftC = sr.x - sr.width / 2, right = sr.x + sr.width / 2 + dx * 0.5
        if (right - leftC >= minSize) { newRect.width = right - leftC; newRect.x = (leftC + right) / 2 }
        break
      }

      // Bottom edge: left third, right third
      case 'nb-l': {
        const top = sr.y - sr.height / 2, bottom = sr.y + sr.height / 2 + dy
        newRect.height = Math.max(minSize, bottom - top); newRect.y = (top + bottom) / 2
        const right = sr.x + sr.width / 2, leftC = sr.x - sr.width / 2 + dx * 0.5
        if (right - leftC >= minSize) { newRect.width = right - leftC; newRect.x = (leftC + right) / 2 }
        break
      }
      case 'nb-r': {
        const top = sr.y - sr.height / 2, bottom = sr.y + sr.height / 2 + dy
        newRect.height = Math.max(minSize, bottom - top); newRect.y = (top + bottom) / 2
        const leftC = sr.x - sr.width / 2, right = sr.x + sr.width / 2 + dx * 0.5
        if (right - leftC >= minSize) { newRect.width = right - leftC; newRect.x = (leftC + right) / 2 }
        break
      }

      // Left edge: top third, bottom third
      case 'wl-t': {
        const right = sr.x + sr.width / 2, leftC = sr.x - sr.width / 2 + dx
        newRect.width = Math.max(minSize, right - leftC); newRect.x = (leftC + right) / 2
        const bottom = sr.y + sr.height / 2, topC = sr.y - sr.height / 2 + dy * 0.5
        if (bottom - topC >= minSize) { newRect.height = bottom - topC; newRect.y = (topC + bottom) / 2 }
        break
      }
      case 'wl-b': {
        const right = sr.x + sr.width / 2, leftC = sr.x - sr.width / 2 + dx
        newRect.width = Math.max(minSize, right - leftC); newRect.x = (leftC + right) / 2
        const topC = sr.y - sr.height / 2, bottom = sr.y + sr.height / 2 + dy * 0.5
        if (bottom - topC >= minSize) { newRect.height = bottom - topC; newRect.y = (topC + bottom) / 2 }
        break
      }

      // Right edge: top third, bottom third
      case 'er-t': {
        const leftC = sr.x - sr.width / 2, right = sr.x + sr.width / 2 + dx
        newRect.width = Math.max(minSize, right - leftC); newRect.x = (leftC + right) / 2
        const bottom = sr.y + sr.height / 2, topC = sr.y - sr.height / 2 + dy * 0.5
        if (bottom - topC >= minSize) { newRect.height = bottom - topC; newRect.y = (topC + bottom) / 2 }
        break
      }
      case 'er-b': {
        const leftC = sr.x - sr.width / 2, right = sr.x + sr.width / 2 + dx
        newRect.width = Math.max(minSize, right - leftC); newRect.x = (leftC + right) / 2
        const topC = sr.y - sr.height / 2, bottom = sr.y + sr.height / 2 + dy * 0.5
        if (bottom - topC >= minSize) { newRect.height = bottom - topC; newRect.y = (topC + bottom) / 2 }
        break
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

  // 16 handles: 4 corners + 12 edge handles (2 per side, placed at 1/3 and 2/3)
  const hPos = {
    nw:  { left: boxLeftPct,            top: boxTopPct,             cursor: 'nw-resize' },
    nt:  { left: boxLeftPct + boxWidthPct/3,  top: boxTopPct,       cursor: 'n-resize' },
    n:   { left: boxLeftPct + boxWidthPct*2/3, top: boxTopPct,      cursor: 'n-resize' },
    ne:  { left: boxLeftPct + boxWidthPct,     top: boxTopPct,      cursor: 'ne-resize' },
    er:  { left: boxLeftPct + boxWidthPct,     top: boxTopPct + boxHeightPct/3,   cursor: 'e-resize' },
    e:   { left: boxLeftPct + boxWidthPct,     top: boxTopPct + boxHeightPct*2/3, cursor: 'e-resize' },
    se:  { left: boxLeftPct + boxWidthPct,     top: boxTopPct + boxHeightPct,     cursor: 'se-resize' },
    sb:  { left: boxLeftPct + boxWidthPct*2/3, top: boxTopPct + boxHeightPct,     cursor: 's-resize' },
    s:   { left: boxLeftPct + boxWidthPct/3,   top: boxTopPct + boxHeightPct,     cursor: 's-resize' },
    sw:  { left: boxLeftPct,            top: boxTopPct + boxHeightPct,     cursor: 'sw-resize' },
    wl:  { left: boxLeftPct,            top: boxTopPct + boxHeightPct*2/3, cursor: 'w-resize' },
    w:   { left: boxLeftPct,            top: boxTopPct + boxHeightPct/3,   cursor: 'w-resize' },
    // Additional mid-edge handles for 2-per-side feel (total 16)
    nw2: { left: boxLeftPct + boxWidthPct*0.15, top: boxTopPct,              cursor: 'n-resize' },
    ne2: { left: boxLeftPct + boxWidthPct*0.85, top: boxTopPct,              cursor: 'n-resize' },
    sw2: { left: boxLeftPct + boxWidthPct*0.15, top: boxTopPct + boxHeightPct, cursor: 's-resize' },
    se2: { left: boxLeftPct + boxWidthPct*0.85, top: boxTopPct + boxHeightPct, cursor: 's-resize' },
  }

  // Map handle keys → drag mode
  const handleToMode = {
    nw: 'nw', nt: 'nt-l', n: 'nt-r', ne: 'ne',
    er: 'er-t', e: 'er-b', se: 'se',
    sb: 'nb-r', s: 'nb-l', sw: 'sw',
    wl: 'wl-b', w: 'wl-t',
    nw2: 'nt-l', ne2: 'nt-r', sw2: 'nb-l', se2: 'nb-r',
  }

  // Corner brackets
  const cornerBrackets = []
  const bk = Math.min(Math.min(boxWidthPct, boxHeightPct) * 0.25, 8)

  const addBracket = (x1, y1, x2, y2) => {
    cornerBrackets.push(
      <line key={`cb-${cornerBrackets.length}`} x1={`${x1}%`} y1={`${y1}%`}
        x2={`${x2}%`} y2={`${y2}%`}
        stroke={color} strokeWidth="2.5" opacity="0.9" />
    )
  }

  addBracket(boxLeftPct, boxTopPct + bk, boxLeftPct, boxTopPct)
  addBracket(boxLeftPct, boxTopPct, boxLeftPct + bk, boxTopPct)
  addBracket(boxLeftPct + boxWidthPct, boxTopPct + bk, boxLeftPct + boxWidthPct, boxTopPct)
  addBracket(boxLeftPct + boxWidthPct - bk, boxTopPct, boxLeftPct + boxWidthPct, boxTopPct)
  addBracket(boxLeftPct, boxTopPct + boxHeightPct - bk, boxLeftPct, boxTopPct + boxHeightPct)
  addBracket(boxLeftPct, boxTopPct + boxHeightPct, boxLeftPct + bk, boxTopPct + boxHeightPct)
  addBracket(boxLeftPct + boxWidthPct, boxTopPct + boxHeightPct - bk, boxLeftPct + boxWidthPct, boxTopPct + boxHeightPct)
  addBracket(boxLeftPct + boxWidthPct - bk, boxTopPct + boxHeightPct, boxLeftPct + boxWidthPct, boxTopPct + boxHeightPct)

  return (
    <>
      {/* Outside dim overlay */}
      {active && (
        <div className="absolute pointer-events-none" style={{ left: 0, top: 0, width: '100%', height: '100%', zIndex: 11 }}>
          <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: `${boxTopPct}%`, background: 'rgba(0,0,0,0.35)' }} />
          <div style={{ position: 'absolute', left: 0, top: `${boxTopPct + boxHeightPct}%`, width: '100%', height: `${100 - boxTopPct - boxHeightPct}%`, background: 'rgba(0,0,0,0.35)' }} />
          <div style={{ position: 'absolute', left: 0, top: `${boxTopPct}%`, width: `${boxLeftPct}%`, height: `${boxHeightPct}%`, background: 'rgba(0,0,0,0.35)' }} />
          <div style={{ position: 'absolute', left: `${boxLeftPct + boxWidthPct}%`, top: `${boxTopPct}%`, width: `${100 - boxLeftPct - boxWidthPct}%`, height: `${boxHeightPct}%`, background: 'rgba(0,0,0,0.35)' }} />
        </div>
      )}

      {/* Dotted edge lines + corner brackets */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 12 }}>
        <line x1={`${boxLeftPct + 2}%`} y1={`${boxTopPct}%`}
          x2={`${boxLeftPct + boxWidthPct - 2}%`} y2={`${boxTopPct}%`}
          stroke={`${color}50`} strokeWidth="1" strokeDasharray="3 4" />
        <line x1={`${boxLeftPct + 2}%`} y1={`${boxTopPct + boxHeightPct}%`}
          x2={`${boxLeftPct + boxWidthPct - 2}%`} y2={`${boxTopPct + boxHeightPct}%`}
          stroke={`${color}50`} strokeWidth="1" strokeDasharray="3 4" />
        <line x1={`${boxLeftPct}%`} y1={`${boxTopPct + 2}%`}
          x2={`${boxLeftPct}%`} y2={`${boxTopPct + boxHeightPct - 2}%`}
          stroke={`${color}50`} strokeWidth="1" strokeDasharray="3 4" />
        <line x1={`${boxLeftPct + boxWidthPct}%`} y1={`${boxTopPct + 2}%`}
          x2={`${boxLeftPct + boxWidthPct}%`} y2={`${boxTopPct + boxHeightPct - 2}%`}
          stroke={`${color}50`} strokeWidth="1" strokeDasharray="3 4" />
        {active && cornerBrackets}
      </svg>

      {/* Move handle */}
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

      {/* 16 resize handles */}
      {active && Object.entries(hPos).map(([key, h]) => {
        const isHovered = hoveredHandle === key
        const mode = handleToMode[key] || key
        const isCorner = ['nw','ne','sw','se'].includes(key)
        const sz = isCorner ? 14 : 10
        return (
          <div key={key} className="absolute" style={{
            left: `${h.left}%`, top: `${h.top}%`,
            transform: 'translate(-50%, -50%)',
            zIndex: 21, cursor: h.cursor,
          }}
            onPointerDown={(e) => handlePointerDown(mode, e)}
            onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
            onClick={handleClick}
            onMouseEnter={() => setHoveredHandle(key)}
            onMouseLeave={() => setHoveredHandle(null)}>
            <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}
              style={{ display: 'block', transition: 'transform 0.15s', transform: isHovered ? 'scale(1.4)' : 'scale(1)' }}>
              <rect x={sz*0.15} y={sz*0.15} width={sz*0.7} height={sz*0.7} rx={sz*0.15}
                fill={isHovered ? color : `${color}cc`}
                stroke="rgba(255,255,255,0.6)" strokeWidth="1"
                style={{ transition: 'fill 0.15s' }}
              />
              <rect x={sz*0.35} y={sz*0.35} width={sz*0.3} height={sz*0.3} rx={sz*0.08}
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
        <span className="text-[9px] font-semibold whitespace-nowrap px-1.5 py-0.5 rounded-full inline-flex items-center gap-1"
          style={{
            background: `${color}dd`,
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.3)',
            backdropFilter: 'blur(4px)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}>
          {label}
        </span>
      </div>
    </>
  )
}
