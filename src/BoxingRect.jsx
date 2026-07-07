import { useState, useCallback } from 'react'

export default function BoxingRect({
  rect, imageSize, toImageCoords, onChange, active, color, label, containerRef
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

  return (
    <>
      {/* Box outline */}
      <div className="absolute pointer-events-none" style={{
        left: `${boxLeftPct}%`, top: `${boxTopPct}%`,
        width: `${boxWidthPct}%`, height: `${boxHeightPct}%`,
        border: `1.5px dashed ${color}80`,
        background: 'transparent', zIndex: 12,
        borderRadius: '1px',
      }} />

      {/* Move handle */}
      {active && (
        <div className="absolute cursor-move" style={{
          left: `${boxLeftPct + boxWidthPct / 2}%`, top: `${boxTopPct + boxHeightPct / 2}%`,
          transform: 'translate(-50%, -50%)', zIndex: 22,
        }}
          onPointerDown={(e) => handlePointerDown('move', e)}
          onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onClick={handleClick}>
          <div className="flex items-center justify-center w-3.5 h-3.5 rounded-full text-[7px]"
            style={{ background: `${color}cc`, color: '#fff', boxShadow: '0 0 4px rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.4)' }}>
            ✥
          </div>
        </div>
      )}

      {/* Resize handles */}
      {active && Object.entries(handles).map(([key, h]) => (
        <div key={key} className="absolute rounded-full" style={{
          left: `${h.left}%`, top: `${h.top}%`,
          width: '8px', height: '8px',
          transform: 'translate(-50%, -50%)',
          background: `${color}cc`, border: '1px solid rgba(255,255,255,0.5)',
          cursor: h.cursor, zIndex: 21,
          boxShadow: '0 0 3px rgba(0,0,0,0.3)',
        }}
          onPointerDown={(e) => handlePointerDown(key, e)}
          onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onClick={handleClick} />
      ))}

      {/* Label */}
      <div className="absolute pointer-events-none" style={{
        left: `${boxLeftPct + boxWidthPct / 2}%`, top: `${boxTopPct - 2}%`,
        transform: 'translate(-50%, -100%)', zIndex: 22,
      }}>
        <span className="text-[10px] font-bold whitespace-nowrap px-1.5 py-0.5 rounded"
          style={{ background: color, color: '#fff' }}>
          {label}
        </span>
      </div>
    </>
  )
}
