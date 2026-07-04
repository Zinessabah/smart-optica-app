import { useState, useCallback, useRef } from 'react'

/**
 * Boxing rectangle — resizable rectangle for lens measurement.
 *
 * rect: { x, y, width, height } in image pixels (x,y = center)
 * imageSize: { width, height } of the source image
 * toImageCoords(clientX, clientY): screen → image pixel coords
 * onChange(newRect): called when rect changes
 * active: whether this box is the active target
 * color: box/handle color
 * label: display label
 * containerRef: ref to the image container (for coordinate mapping)
 */
export default function BoxingRect({
  rect, imageSize, toImageCoords, onChange, active, color, label, containerRef
}) {
  const [drag, setDrag] = useState(null) // { mode, startClient, startRect }
  const HANDLE = 10 // handle size in screen px (visual only)

  const handlePointerDown = useCallback((mode, e) => {
    e.stopPropagation()
    e.preventDefault()
    e.target.setPointerCapture(e.pointerId)
    setDrag({ mode, startClient: { x: e.clientX, y: e.clientY }, startRect: { ...rect } })
  }, [rect])

  // Block click from bubbling to parent (prevents accidental marker placement)
  const handleClick = useCallback((e) => {
    e.stopPropagation()
  }, [])

  const handlePointerMove = useCallback((e) => {
    if (!drag) return
    const startImg = toImageCoords(drag.startClient.x, drag.startClient.y)
    const currImg = toImageCoords(e.clientX, e.clientY)
    if (!startImg || !currImg) return
    const dx = currImg.x - startImg.x
    const dy = currImg.y - startImg.y
    const minSize = 15 // minimum 15px in image coords

    const sr = drag.startRect
    let newRect = { x: sr.x, y: sr.y, width: sr.width, height: sr.height }

    switch (drag.mode) {
      case 'move':
        newRect.x = sr.x + dx
        newRect.y = sr.y + dy
        break
      case 'nw': { // top-left corner → resize from SE
        const seX = sr.x + sr.width / 2
        const seY = sr.y + sr.height / 2
        const nwX = sr.x - sr.width / 2 + dx
        const nwY = sr.y - sr.height / 2 + dy
        newRect.width = Math.max(minSize, seX - nwX)
        newRect.height = Math.max(minSize, seY - nwY)
        newRect.x = (nwX + seX) / 2
        newRect.y = (nwY + seY) / 2
        break
      }
      case 'ne': { // top-right corner → resize from SW
        const swX = sr.x - sr.width / 2
        const swY = sr.y + sr.height / 2
        const neX = sr.x + sr.width / 2 + dx
        const neY = sr.y - sr.height / 2 + dy
        newRect.width = Math.max(minSize, neX - swX)
        newRect.height = Math.max(minSize, swY - neY)
        newRect.x = (swX + neX) / 2
        newRect.y = (neY + swY) / 2
        break
      }
      case 'sw': { // bottom-left corner → resize from NE
        const neX = sr.x + sr.width / 2
        const neY = sr.y - sr.height / 2
        const swX = sr.x - sr.width / 2 + dx
        const swY = sr.y + sr.height / 2 + dy
        newRect.width = Math.max(minSize, neX - swX)
        newRect.height = Math.max(minSize, swY - neY)
        newRect.x = (swX + neX) / 2
        newRect.y = (neY + swY) / 2
        break
      }
      case 'se': { // bottom-right corner → resize from NW
        const nwX = sr.x - sr.width / 2
        const nwY = sr.y - sr.height / 2
        const seX = sr.x + sr.width / 2 + dx
        const seY = sr.y + sr.height / 2 + dy
        newRect.width = Math.max(minSize, seX - nwX)
        newRect.height = Math.max(minSize, seY - nwY)
        newRect.x = (nwX + seX) / 2
        newRect.y = (nwY + seY) / 2
        break
      }
      case 'n': { // top edge
        const bottom = sr.y + sr.height / 2
        const top = sr.y - sr.height / 2 + dy
        newRect.height = Math.max(minSize, bottom - top)
        newRect.y = (top + bottom) / 2
        break
      }
      case 's': { // bottom edge
        const top = sr.y - sr.height / 2
        const bottom = sr.y + sr.height / 2 + dy
        newRect.height = Math.max(minSize, bottom - top)
        newRect.y = (top + bottom) / 2
        break
      }
      case 'w': { // left edge
        const right = sr.x + sr.width / 2
        const left = sr.x - sr.width / 2 + dx
        newRect.width = Math.max(minSize, right - left)
        newRect.x = (left + right) / 2
        break
      }
      case 'e': { // right edge
        const left = sr.x - sr.width / 2
        const right = sr.x + sr.width / 2 + dx
        newRect.width = Math.max(minSize, right - left)
        newRect.x = (left + right) / 2
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

  // Convert from image coords to percentage positions (compensating letterboxing)
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

  // Image pixel → percentage within container
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

  // Handle positions (in percentage)
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
      <div
        className="absolute pointer-events-none"
        style={{
          left: `${boxLeftPct}%`,
          top: `${boxTopPct}%`,
          width: `${boxWidthPct}%`,
          height: `${boxHeightPct}%`,
          border: active ? `2.5px solid ${color}` : `2px dashed ${color}`,
          background: `${color}10`,
          zIndex: 12,
          borderRadius: '2px',
          boxShadow: active ? `0 0 12px ${color}40` : 'none',
        }}
      />

      {/* Drag center area (only interactive when active) */}
      {active && (
        <div
          className="absolute cursor-move"
          style={{
            left: `${boxLeftPct + boxWidthPct * 0.25}%`,
            top: `${boxTopPct + boxHeightPct * 0.25}%`,
            width: `${boxWidthPct * 0.5}%`,
            height: `${boxHeightPct * 0.5}%`,
            zIndex: 20,
          }}
          onPointerDown={(e) => handlePointerDown('move', e)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onClick={handleClick}
        />
      )}

      {/* Resize handles (only interactive when active) */}
      {active && Object.entries(handles).map(([key, h]) => (
        <div
          key={key}
          className="absolute rounded-full border-2"
          style={{
            left: `${h.left}%`,
            top: `${h.top}%`,
            width: `${HANDLE}px`,
            height: `${HANDLE}px`,
            transform: 'translate(-50%, -50%)',
            background: color,
            borderColor: '#fff',
            cursor: h.cursor,
            zIndex: 21,
            boxShadow: '0 0 4px rgba(0,0,0,0.4)',
          }}
          onPointerDown={(e) => handlePointerDown(key, e)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onClick={handleClick}
        />
      ))}

      {/* Label */}
      <div
        className="absolute pointer-events-none"
        style={{
          left: `${boxLeftPct + boxWidthPct / 2}%`,
          top: `${boxTopPct - 2}%`,
          transform: 'translate(-50%, -100%)',
          zIndex: 22,
        }}
      >
        <span className="text-[10px] font-bold whitespace-nowrap px-1.5 py-0.5 rounded"
          style={{ background: color, color: '#fff' }}>
          {label}
        </span>
      </div>
    </>
  )
}
