/**
 * Pure magnifying glass (loupe). Receives position from parent.
 *
 * Props:
 *   imageUrl  - background image
 *   pos       - { x, y } position over the container (or null to hide)
 *   zoom      - magnification (default 3)
 *   size      - diameter in px (default 140)
 */
export default function Loupe({ imageUrl, pos, zoom = 3, size = 140 }) {
  if (!pos || !imageUrl) return null

  const half = size / 2
  const bgSize = `${zoom * 100}%`
  const bgX = -(pos.x * zoom - half)
  const bgY = -(pos.y * zoom - half)

  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: pos.x - half,
        top: pos.y - half,
        width: size,
        height: size,
        borderRadius: '50%',
        border: '3px solid #c9975a',
        boxShadow: '0 0 0 4px rgba(0,0,0,0.3), 0 0 20px rgba(0,0,0,0.4)',
        backgroundImage: `url(${imageUrl})`,
        backgroundSize: bgSize,
        backgroundPosition: `${bgX}px ${bgY}px`,
        backgroundRepeat: 'no-repeat',
        overflow: 'hidden',
        zIndex: 100,
      }}
    >
      {/* Crosshair */}
      <svg className="absolute inset-0 w-full h-full">
        {/* Gap in crosshair center for visibility */}
        <line x1="50%" y1="25%" x2="50%" y2="42%" stroke="#fff" strokeWidth="1" opacity="0.85" />
        <line x1="50%" y1="58%" x2="50%" y2="75%" stroke="#fff" strokeWidth="1" opacity="0.85" />
        <line x1="25%" y1="50%" x2="42%" y2="50%" stroke="#fff" strokeWidth="1" opacity="0.85" />
        <line x1="58%" y1="50%" x2="75%" y2="50%" stroke="#fff" strokeWidth="1" opacity="0.85" />
        {/* Tiny center dot */}
        <circle cx="50%" cy="50%" r="1.5" fill="#c9975a" opacity="0.9" />
      </svg>
    </div>
  )
}
