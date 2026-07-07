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
        border: '2px solid var(--color-gold)',
        boxShadow: '0 0 0 4px rgba(0,0,0,0.4), 0 0 24px rgba(0,0,0,0.5)',
        backgroundImage: `url(${imageUrl})`,
        backgroundSize: bgSize,
        backgroundPosition: `${bgX}px ${bgY}px`,
        backgroundRepeat: 'no-repeat',
        overflow: 'hidden',
        zIndex: 100,
      }}
    >
      <svg className="absolute inset-0 w-full h-full">
        <line x1="50%" y1="25%" x2="50%" y2="42%" stroke="#fff" strokeWidth="1" opacity="0.85" />
        <line x1="50%" y1="58%" x2="50%" y2="75%" stroke="#fff" strokeWidth="1" opacity="0.85" />
        <line x1="25%" y1="50%" x2="42%" y2="50%" stroke="#fff" strokeWidth="1" opacity="0.85" />
        <line x1="58%" y1="50%" x2="75%" y2="50%" stroke="#fff" strokeWidth="1" opacity="0.85" />
        <circle cx="50%" cy="50%" r="1.5" fill="var(--color-gold)" opacity="0.9" />
      </svg>
    </div>
  )
}
