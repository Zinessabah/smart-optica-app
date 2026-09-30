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

/**
 * Les 3 mires d'un côté forment un triangle ISOCÈLE : base 25,00 mm (les deux mires basses) et
 * deux pattes de hypot(12,50 ; 16,00) = 20,3039 mm (la mire surélevée est à mi-profondeur et
 * 16 mm plus haut). Cotes MESURÉES sur le clip, miroir de `backend/clip_geometry.py`.
 *
 * C'est ce rapport qui rend un placement VÉRIFIABLE : avec 2 points, n'importe quel écartement
 * « est » 25 mm par définition, donc rien ne peut contredire une pose approximative.
 */
export const ISOCELE_RATIO = LATERAL_SPACING_MM / Math.hypot(12.5, 16.0)

/**
 * Tolérance sur l'écart du rapport — LA MÊME que le détecteur (`backend/lateral_checker.py`,
 * `RATIO_TOL = 0.08`) et la même DÉFINITION (base / patte la plus longue). Si les deux
 * divergeaient, le même placement serait accepté d'un côté et refusé de l'autre.
 *
 * Mesuré : photos réelles à triangle établi −1,75 % · −3,16 % · −4,44 % (l'écart vient de la pose :
 * un lacet de 20° vaut ~−4,4 %) ; un placement qui n'est pas le triangle du clip dépasse 15 %.
 * 8 % laisse donc 1,8× de marge sur la pire photo réelle et rejette large.
 */
export const ISOCELE_TOL = 0.08

/** En dessous, les 2 points sont confondus : l'échelle qui en découle est absurde. */
const MIN_GAP_PX = 10

const _dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y)

/**
 * Évalue un triplet de points comme étant le triangle du clip.
 *
 * La BASE est le côté le plus long — 25,00 mm > 20,30 mm par construction — donc AUCUN rôle n'a
 * besoin d'être connu à l'avance, ni l'ordre dans lequel l'utilisateur a posé ses marqueurs :
 * c'est la géométrie qui décide.
 *
 * @param {Array<{x:number,y:number}>} points
 * @returns {{baseIndexes:[number,number], basePx:number, pattesPx:[number,number],
 *            errPct:number, coherent:boolean}|null}  null si moins de 3 points
 */
export function evalClipTriangle(points) {
  if (!Array.isArray(points) || points.length !== 3) return null
  const cotes = [[0, 1], [0, 2], [1, 2]]
    .map(([i, j]) => ({ i, j, d: _dist(points[i], points[j]) }))
    .sort((a, b) => b.d - a.d)
  const [base, pA, pB] = cotes
  if (!(base.d > 0) || !(pA.d > 0)) return null
  // Même définition que le détecteur : base / patte la plus longue (le cas le plus défavorable).
  const errPct = (base.d / pB.d / ISOCELE_RATIO - 1) * 100
  return {
    baseIndexes: [base.i, base.j],
    basePx: base.d,
    pattesPx: [pA.d, pB.d],
    errPct: Math.round(errPct * 100) / 100,
    coherent: Math.abs(errPct) <= ISOCELE_TOL * 100,
  }
}

/** Un point de la réponse backend → {x, y} entiers, ou null si absent/illisible. */
function _point(raw, imageSize) {
  if (!Array.isArray(raw) || raw.length !== 2) return null
  const p = { x: Math.round(Number(raw[0])), y: Math.round(Number(raw[1])) }
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
  if (p.x < 0 || p.y < 0 || p.x > imageSize.width || p.y > imageSize.height) return null
  return p
}

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

  // 5. Le backend juge le couple de mires invraisemblable (champ hors bornes) : on n'amorce PAS.
  //    Une échelle fausse contaminerait TOUTES les mesures — mieux vaut des poignées à poser
  //    à la main qu'un point de départ qui a l'air juste.
  //    ⚠️ Ce champ ne compare PLUS l'échelle latérale à l'échelle FRONTALE : les deux photos
  //    sont prises à des distances différentes (c'est la règle), et l'échelle latérale vient
  //    désormais de la photo latérale seule. Comparer les deux refusait un amorçage juste.
  //    ⚠️ `scale_plausible` peut être absent (ancien backend) : seul `false` bloque.
  if (result.scale_plausible === false) return { ok: false, reason: 'implausible_scale' }

  // 6. La 3e mire (la surélevée), quand le détecteur a établi le triangle isocèle du clip.
  //    Facultative — un backend sans ce champ reste utilisable — mais c'est elle qui permet à
  //    l'app de VÉRIFIER un placement à 3 marqueurs au lieu de faire confiance.
  const raised = _point(result.lateral_raised, imageSize)

  return {
    ok: true,
    reason: 'ok',
    markers,
    raised,
    // Contrôle croisé : le triangle des 3 points annoncés par le backend doit être cohérent.
    // (Les 2 mires seules ne permettent AUCUN contrôle — c'est tout l'intérêt du 3e point.)
    triangle: evalClipTriangle(raised ? [...markers, raised] : null),
    px: Math.round(px),
    // Les mires sont à hauteur d'œil → leur moyenne donne la ligne du vertex.
    eyeLine: Math.round((markers[0].y + markers[1].y) / 2),
    centerX: Math.round((markers[0].x + markers[1].x) / 2),
  }
}
