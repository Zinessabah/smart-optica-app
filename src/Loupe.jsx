/**
 * Pure magnifying glass (loupe).
 *
 * Props:
 *   imageUrl     - background image
 *   pos          - { x, y } position over the container (container-relative px), or null
 *   zoom         - magnification (default 3)
 *   size         - diameter in px (default 140)
 *   displayRect  - { left, top, width, height } of actual image display area within container
 *                  (compensates object-fit:contain letterboxing)
 *   imageSize    - { width, height } natural image dimensions (needed with displayRect)
 */
export default function Loupe({ imageUrl, pos, zoom = 3, size = 140, displayRect, imageSize }) {
  if (!pos || !imageUrl) return null

  const half = size / 2
  const bgSize = `${zoom * 100}%`

  // If we have displayRect + imageSize, map pixel-level image coords to screen coords
  // so the loupe background aligns with the actual image pixels under the cursor
  let bgX, bgY

  if (displayRect && imageSize) {
    // Convert screen position (within container) to image pixel coordinates
    const imgX = ((pos.x - displayRect.left) / displayRect.width) * imageSize.width
    const imgY = ((pos.y - displayRect.top) / displayRect.height) * imageSize.height
    // Then convert back: background image fills the entire element at zoom level
    // backgroundPosition offsets the image so the pixel under cursor is centered
    bgX = -(imgX * zoom - half)
    bgY = -(imgY * zoom - half)
  } else {
    // Fallback: assume 1:1 mapping (no letterboxing)
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
