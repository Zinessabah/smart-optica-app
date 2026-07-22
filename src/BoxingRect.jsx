import { useState, useCallback } from 'react'

export default function BoxingRect({
  rect, imageSize, toImageCoords, onChange, active, label, containerRef
}) {
  const [drag, setDrag] = useState(null)

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
        // Coin opposé fixe = sud-est (se)
        const seX = sr.x + sr.width / 2
        const seY = sr.y + sr.height / 2
        const nwX = sr.x - sr.width / 2 + dx
        const nwY = sr.y - sr.height / 2 + dy
        const w = Math.max(minSize, seX - nwX)
        const h = Math.max(minSize, seY - nwY)
        newRect.x = nwX + w / 2
        newRect.y = nwY + h / 2
        newRect.width = w
        newRect.height = h
        break
      }
      case 'ne': {
        // Coin opposé fixe = sud-ouest (sw)
        const swX = sr.x - sr.width / 2
        const swY = sr.y + sr.height / 2
        const neX = sr.x + sr.width / 2 + dx
        const neY = sr.y - sr.height / 2 + dy
        const w = Math.max(minSize, neX - swX)
        const h = Math.max(minSize, swY - neY)
        newRect.x = swX + w / 2
        newRect.y = neY + h / 2
        newRect.width = w
        newRect.height = h
        break
      }
      case 'sw': {
        // Coin opposé fixe = nord-est (ne)
        const neX = sr.x + sr.width / 2
        const neY = sr.y - sr.height / 2
        const swX = sr.x - sr.width / 2 + dx
        const swY = sr.y + sr.height / 2 + dy
        const w = Math.max(minSize, neX - swX)
        const h = Math.max(minSize, swY - neY)
        newRect.x = swX + w / 2
        newRect.y = neY + h / 2
        newRect.width = w
        newRect.height = h
        break
      }
      case 'se': {
        // Coin opposé fixe = nord-ouest (nw)
        const nwX = sr.x - sr.width / 2
        const nwY = sr.y - sr.height / 2
        const seX = sr.x + sr.width / 2 + dx
        const seY = sr.y + sr.height / 2 + dy
        const w = Math.max(minSize, seX - nwX)
        const h = Math.max(minSize, seY - nwY)
        newRect.x = nwX + w / 2
        newRect.y = nwY + h / 2
        newRect.width = w
        newRect.height = h
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

  // 4 coins
  const corners = {
    nw: { mode: 'nw', cursor: 'nw-resize', l: boxLeftPct, t: boxTopPct },
    ne: { mode: 'ne', cursor: 'ne-resize', l: boxLeftPct + boxWidthPct, t: boxTopPct },
    sw: { mode: 'sw', cursor: 'sw-resize', l: boxLeftPct, t: boxTopPct + boxHeightPct },
    se: { mode: 'se', cursor: 'se-resize', l: boxLeftPct + boxWidthPct, t: boxTopPct + boxHeightPct },
  }

  const handleSz = 12

  return (
    <>
      {/* Bordure blanche fine */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 12 }}>
        <rect x={`${boxLeftPct}%`} y={`${boxTopPct}%`}
          width={`${boxWidthPct}%`} height={`${boxHeightPct}%`}
          fill="none"
          stroke="rgba(255,255,255,0.5)"
          strokeWidth="0.8"
          strokeDasharray="3 2" />
      </svg>

      {/* Move handle — centre du rectangle */}
      {active && (
        <div className="absolute cursor-move" style={{
          left: `${boxLeftPct + boxWidthPct / 2}%`, top: `${boxTopPct + boxHeightPct / 2}%`,
          transform: 'translate(-50%, -50%)', zIndex: 22,
        }}
          onPointerDown={(e) => handlePointerDown('move', e)}
          onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onClick={handleClick}>
          <svg width="18" height="18" viewBox="0 0 18 18">
            <circle cx="9" cy="9" r="8" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
            <path d="M9 3 L10.5 6 L7.5 6 Z M9 15 L10.5 12 L7.5 12 Z M3 9 L6 7.5 L6 10.5 Z M15 9 L12 7.5 L12 10.5 Z"
              fill="rgba(255,255,255,0.6)" />
          </svg>
        </div>
      )}

      {/* 4 petits carrés aux coins */}
      {active && Object.entries(corners).map(([key, c]) => (
        <div key={key} className="absolute" style={{
          left: `${c.l}%`, top: `${c.t}%`,
          transform: 'translate(-50%, -50%)',
          zIndex: 21, cursor: c.cursor,
        }}
          onPointerDown={(e) => handlePointerDown(c.mode, e)}
          onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
          onClick={handleClick}>
          <svg width={handleSz} height={handleSz} viewBox={`0 0 ${handleSz} ${handleSz}`}
            style={{ display: 'block' }}>
            <rect x="2" y="2" width={handleSz - 4} height={handleSz - 4} rx="2"
              fill="rgba(255,255,255,0.8)"
              stroke="rgba(0,0,0,0.3)" strokeWidth="0.5" />
          </svg>
        </div>
      ))}

      {/* Label badge — transparent */}
      <div className="absolute pointer-events-none" style={{
        left: `${boxLeftPct + boxWidthPct / 2}%`, top: `${boxTopPct}%`,
        transform: 'translate(-50%, -50%)', zIndex: 22,
      }}>
        <span className="text-[9px] font-medium whitespace-nowrap"
          style={{
            color: 'rgba(255,255,255,0.5)',
            textShadow: '0 0 6px rgba(0,0,0,0.8)',
            opacity: 0.5,
          }}>
          {label}
        </span>
      </div>
    </>
  )
}
