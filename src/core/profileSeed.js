/**
 * Smart Optica — amorçage des positions de départ de la photo de PROFIL.
 *
 * Le backend détecte les **2 mires du clip latéral** (`/api/analyze-profile`). Ces 2 points
 * SONT les 2 poignées de l'échelle (la consigne est de les poser sur les 2 cercles noirs) :
 * les détecter permet donc de partir avec une échelle JUSTE, au lieu de poignées posées
 * au jugé. La moyenne de leurs hauteurs donne en plus la **ligne d'œil** — les mires sont
 * montées SUR la monture — dont on se sert pour le vertex.
 *
 * ⚠ REPÈRE DE COORDONNÉES. La réponse est exprimée dans l'espace de l'image APRÈS
 * orientation EXIF (3024×4032 pour un cliché 4032×3024 d'orientation 6 : mesuré sur les
 * photos réelles du dossier `backend/uploads`). Le navigateur applique la même orientation
 * (`image-orientation: from-image`), donc `imageSize` et la réponse partagent le MÊME repère.
 * On REFUSE malgré tout d'amorcer si les deux diffèrent : un décalage de 90° poserait les
 * mires à côté, et fausserait TOUTES les mesures puisque l'échelle vient de leur écartement.
 *
 * Ce module est PUR (aucun accès réseau) : la décision « j'amorce / je n'amorce pas » se
 * teste donc sans monter le composant.
 */

/** Écartement réel des 2 mires du clip latéral (design actuel : « 2 cercles noirs à 25 mm »). */
export const LATERAL_SPACING_MM = 25

/** En dessous, les 2 points sont confondus : l'échelle qui en découle est absurde. */
const MIN_GAP_PX = 10

/**
 * @param {object|null} result      réponse JSON de /api/analyze-profile
 * @param {{width:number,height:number}|null} imageSize  taille d'image vue par le navigateur
 * @returns {{ok:true, reason:'ok', markers:Array<{x:number,y:number}>, px:number,
 *            eyeLine:number, centerX:number}
 *          | {ok:false, reason:string}}
 */
export function seedFromProfile(result, imageSize) {
  if (!result || !imageSize) return { ok: false, reason: 'no_input' }
  if (!imageSize.width || !imageSize.height) return { ok: false, reason: 'no_input' }

  // 1. Même espace de coordonnées que l'image affichée
  if (result.width !== imageSize.width || result.height !== imageSize.height) {
    return { ok: false, reason: 'space_mismatch' }
  }

  // 2. Deux mires, valeurs numériques
  const raw = result.lateral_markers
  if (!Array.isArray(raw) || raw.length !== 2) return { ok: false, reason: 'no_markers' }
  const markers = raw.map((m) => ({ x: Math.round(Number(m?.[0])), y: Math.round(Number(m?.[1])) }))
  if (markers.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    return { ok: false, reason: 'bad_numbers' }
  }

  // 3. Dans le cadre (une mire hors image = détection fantaisiste)
  if (markers.some((p) => p.x < 0 || p.y < 0 || p.x > imageSize.width || p.y > imageSize.height)) {
    return { ok: false, reason: 'out_of_frame' }
  }

  // 4. Écartement non dégénéré
  const px = Math.hypot(markers[1].x - markers[0].x, markers[1].y - markers[0].y)
  if (!(px >= MIN_GAP_PX)) return { ok: false, reason: 'degenerate' }

  // 5. Le backend juge l'échelle invraisemblable (champ hors bornes) : on n'amorce PAS.
  //    Une échelle fausse contaminerait TOUTES les mesures — mieux vaut des poignées à
  //    poser à la main qu'un point de départ qui a l'air juste.
  //    ⚠ `scale_consistent` peut être absent (ancien backend) : seul `false` bloque.
  if (result.scale_consistent === false) return { ok: false, reason: 'inconsistent_scale' }

  return {
    ok: true,
    reason: 'ok',
    markers,
    px: Math.round(px),
    // Les mires sont à hauteur d'œil → leur moyenne donne la ligne du vertex.
    eyeLine: Math.round((markers[0].y + markers[1].y) / 2),
    centerX: Math.round((markers[0].x + markers[1].x) / 2),
  }
}
