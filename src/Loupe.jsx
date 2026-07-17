/**
 * Pure magnifying glass (loupe) avec calcul exact d'alignement pour images avec letterboxing.
 */
export default function Loupe({ imageUrl, pos, zoom = 3, size = 140, displayRect, imageSize }) {
  if (!pos || !imageUrl) return null

  const half = size / 2

  let bgSizeW, bgSizeH
  let bgX, bgY

  // displayRect représente le rectangle d'affichage réel de la photo dans l'écran de l'iPad
  if (displayRect && displayRect.width > 0 && displayRect.height > 0) {
    // 1. Taille totale de l'image d'arrière-plan agrandie de "zoom" fois
    bgSizeW = displayRect.width * zoom
    bgSizeH = displayRect.height * zoom

    // 2. Coordonnées de la souris relatives à la photo affichée à l'écran
    const mouseInImageX = pos.x - displayRect.left
    const mouseInImageY = pos.y - displayRect.top

    // 3. Positionnement du background pour centrer cette coordonnée sous la loupe
    // La position de la texture doit être décalée de -(clientX_dans_vrai_image * zoom) + la moitié de la loupe
    bgX = - (mouseInImageX * zoom) + half
    bgY = - (mouseInImageY * zoom) + half
  } else {
    // Fallback si pas de displayRect (1:1 container mapping)
    bgSizeW = 100 * zoom + '%'
    bgSizeH = 'auto'
    bgX = -(pos.x * zoom - half)
    bgY = -(pos.y * zoom - half)
  }

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
        backgroundSize: typeof bgSizeW === 'number' ? `${bgSizeW}px ${bgSizeH}px` : bgSizeW,
        backgroundPosition: `${bgX}px ${bgY}px`,
        backgroundRepeat: 'no-repeat',
        overflow: 'hidden',
        zIndex: 100,
      }}
    >
      {/* Réticule de visée */}
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
