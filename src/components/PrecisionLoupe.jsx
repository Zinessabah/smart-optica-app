/**
 * Loupe de précision — bulle grossissante dont le CENTRE est exactement le point mesuré.
 *
 * Instrument PARTAGÉ : l'écran des repères et l'écran de calibrage utilisent la même
 * loupe, pour qu'une même visée se comporte pareil partout (aucune copie divergente).
 *
 * Champ de vision PHYSIQUE constant (en mm) : la précision ne dépend ni de la résolution
 * de la photo ni de la taille d'affichage. Un facteur « ×N » constant n'aurait aucun sens
 * métrologique. Sans calibrage disponible, repli sur un pourcentage de la largeur d'image.
 *
 * Purement visuelle (`pointerEvents: none`) : elle ne déplace jamais la mesure.
 */

const LOUPE_R = 62        // rayon en px à l'écran
const MAX_ZOOM = 20

export default function PrecisionLoupe({
  dr,               // rectangle réellement affiché de l'image (px écran)
  imageSize,        // { width, height } en px photo
  imageUrl,
  pos,              // point mesuré, en px photo
  color,
  label,
  mmPerPx,          // échelle physique, si connue
  spanMm = 12,      // champ de vision visé, en mm
  fallbackPct = 6,  // repli SANS échelle connue : % de la largeur d'image
  hint,             // texte de remplacement sous l'étiquette (ex. « relâcher pour poser »)
  scaleBar = true,  // cale étalon 1 mm
}) {
  if (!dr || !pos || !imageSize || !imageUrl) return null

  // Sans échelle connue, le repli en % doit rester PETIT : à 6 % d'une photo de
  // 3024 px, la bulle de 124 px afficherait moins que 1:1 (zoom 0,68) — elle
  // rapetisserait l'image au lieu de la grossir.
  const spanPx = mmPerPx ? spanMm / mmPerPx : imageSize.width * (fallbackPct / 100)
  const zoom = Math.min(MAX_ZOOM, Math.max(1, (LOUPE_R * 2) / Math.max(spanPx, 1)))
  const cx = (pos.x / imageSize.width) * dr.width
  const cy = (pos.y / imageSize.height) * dr.height
  // Au-dessus du doigt ; bascule en dessous s'il n'y a pas la place
  const above = cy > LOUPE_R * 2 + 30
  const by = above ? cy - LOUPE_R - 40 : cy + LOUPE_R + 40
  const maxX = Math.max(LOUPE_R + 6, dr.width - LOUPE_R - 6)
  const bx = Math.min(Math.max(cx, LOUPE_R + 6), maxX)

  const white = 'rgba(255,255,255,0.85)'
  const centre = { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }

  return (
    <div data-loupe="1" style={{
      position: 'absolute', left: bx, top: by,
      width: LOUPE_R * 2, height: LOUPE_R * 2,
      transform: 'translate(-50%, -50%)',
      borderRadius: '50%', overflow: 'hidden',
      border: `2px solid ${color}`,
      boxShadow: '0 8px 28px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,0,0,0.6)',
      backgroundImage: `url(${imageUrl})`,
      backgroundSize: `${imageSize.width * zoom}px ${imageSize.height * zoom}px`,
      backgroundPosition: `${LOUPE_R - pos.x * zoom}px ${LOUPE_R - pos.y * zoom}px`,
      backgroundRepeat: 'no-repeat',
      zIndex: 60, pointerEvents: 'none',
    }}>
      {/* Réticule — le point mesuré est pile au centre */}
      <div style={{ ...centre, width: 30, height: 1, background: white }} />
      <div style={{ ...centre, width: 1, height: 30, background: white }} />
      <div style={{ ...centre, width: 40, height: 40, border: '1px solid rgba(255,255,255,0.25)', borderRadius: '50%' }} />
      <div style={{ ...centre, width: 4, height: 4, background: color, borderRadius: '50%', boxShadow: '0 0 4px rgba(0,0,0,0.9)' }} />

      {/* Cale étalon : 1 mm à l'échelle de la photo — la loupe reste un instrument */}
      {scaleBar && mmPerPx && (() => {
        const barW = Math.max(6, (1 / mmPerPx) * zoom)
        return (
          <div data-mm-bar={barW.toFixed(2)} style={{
            position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)',
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <div style={{ width: barW, height: 7, borderLeft: '1px solid #fff', borderRight: '1px solid #fff', borderBottom: '1px solid #fff', opacity: 0.9 }} />
            <span style={{ fontSize: 8, fontWeight: 600, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.95)' }}>1 mm</span>
          </div>
        )
      })()}

      {/* Étiquette */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 6, textAlign: 'center',
        fontSize: 10, fontWeight: 700, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.95)',
      }}>
        {label} · {hint || (mmPerPx ? `${spanMm} mm` : `${Math.round(spanPx)} px`)}
      </div>
    </div>
  )
}
