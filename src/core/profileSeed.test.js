import { describe, it, expect } from 'vitest'
import { seedFromProfile, evalClipTriangle, LATERAL_SPACING_MM } from './profileSeed'

/**
 * Réponse RÉELLE de /api/analyze-profile, relevée sur une photo de profil du projet
 * (backend/uploads/<user>/06f17b35-…_profile.png — cliché 4032×3024, EXIF orientation 6).
 * Le backend travaille après rotation : 3024×4032.
 *
 * `scale_mm_per_px` est l'échelle de la PHOTO LATÉRALE, mesurée sur l'écartement des 2 mires
 * (25,00 mm / 239,8 px). Elle n'a RIEN à voir avec l'échelle de la photo faciale : les deux
 * clichés sont pris à des distances différentes.
 */
const REPONSE_REELLE = {
  width: 3024,
  height: 4032,
  lateral_markers: [[2484, 989], [2455, 1227]],
  scale_mm_per_px: 0.104271,
  scale_plausible: true,
  pantoscopic_angle: 0.1,
  vertex_distance: 28.1,
  face_detected: true,
  temple_angle: -7.0,
}

/** Ce que voit le navigateur (orientation EXIF appliquée) : MÊME espace que le backend. */
const IMAGE_SIZE = { width: 3024, height: 4032 }

const KO = (result, imageSize = IMAGE_SIZE) => seedFromProfile(result, imageSize)

describe('seedFromProfile — amorçage depuis les mires détectées', () => {
  it('amorce sur la réponse réelle : 2 mires, écart ≈ 25 mm, ligne d’œil et centre', () => {
    const s = KO(REPONSE_REELLE)
    expect(s.ok).toBe(true)
    expect(s.markers).toEqual([{ x: 2484, y: 989 }, { x: 2455, y: 1227 }])
    // L'écart détecté, lu à l'échelle de la photo latérale annoncée par le backend, vaut bien 25 mm
    expect(s.px).toBe(240)
    expect(s.px * REPONSE_REELLE.scale_mm_per_px).toBeCloseTo(LATERAL_SPACING_MM, 0)
    // Les mires sont à hauteur d'œil → moyenne des hauteurs
    expect(s.eyeLine).toBe(1108)
    expect(s.centerX).toBe(2470)
  })

  it('REFUSE quand l’espace de coordonnées diffère (piège de la rotation EXIF 90°)', () => {
    // Le piège réel : navigateur 4032×3024, backend 3024×4032 → les mires seraient
    // posées à côté, et l'échelle (donc TOUTES les mesures) serait fausse.
    expect(KO(REPONSE_REELLE, { width: 4032, height: 3024 }))
      .toEqual({ ok: false, reason: 'space_mismatch' })
  })

  it('REFUSE un couple de mires invraisemblable (champ hors bornes, jugé par le backend)', () => {
    expect(KO({ ...REPONSE_REELLE, scale_plausible: false }))
      .toEqual({ ok: false, reason: 'implausible_scale' })
  })

  it('n’exige PAS `scale_plausible` (champ absent d’un ancien backend)', () => {
    const { scale_plausible, ...sansChamp } = REPONSE_REELLE
    expect(scale_plausible).toBe(true)          // le champ existait bien dans la réponse
    expect(KO(sansChamp).ok).toBe(true)
  })

  it('amorce MALGRÉ une échelle frontale très différente (les 2 photos n’ont pas la même échelle)', () => {
    // Le verrou retiré : l'ancien champ `scale_consistent` comparait l'échelle latérale à
    // l'échelle FACIALE et refusait l'amorçage au-delà de 10 % d'écart — donc quasiment toujours,
    // alors que la détection était juste. Rien dans la réponse ne doit plus porter ce verdict.
    const s = KO(REPONSE_REELLE)
    expect(s.ok).toBe(true)
    expect('scale_consistent' in REPONSE_REELLE).toBe(false)
  })

  it('REFUSE moins de 2 mires', () => {
    expect(KO({ ...REPONSE_REELLE, lateral_markers: [[10, 10]] }))
      .toEqual({ ok: false, reason: 'no_markers' })
    expect(KO({ ...REPONSE_REELLE, lateral_markers: undefined }))
      .toEqual({ ok: false, reason: 'no_markers' })
  })

  it('REFUSE des coordonnées non numériques', () => {
    expect(KO({ ...REPONSE_REELLE, lateral_markers: [['a', 'b'], [1, 2]] }))
      .toEqual({ ok: false, reason: 'bad_numbers' })
  })

  it('REFUSE une mire hors du cadre', () => {
    expect(KO({ ...REPONSE_REELLE, lateral_markers: [[-5, 100], [300, 400]] }))
      .toEqual({ ok: false, reason: 'out_of_frame' })
    expect(KO({ ...REPONSE_REELLE, lateral_markers: [[100, 100], [5000, 400]] }))
      .toEqual({ ok: false, reason: 'out_of_frame' })
  })

  it('REFUSE 2 points confondus (échelle qui exploserait)', () => {
    expect(KO({ ...REPONSE_REELLE, lateral_markers: [[100, 100], [104, 103]] }))
      .toEqual({ ok: false, reason: 'degenerate' })
  })

  it('REFUSE une entrée vide', () => {
    expect(KO(null)).toEqual({ ok: false, reason: 'no_input' })
    expect(KO(REPONSE_REELLE, null)).toEqual({ ok: false, reason: 'no_input' })
    expect(KO(REPONSE_REELLE, { width: 0, height: 0 })).toEqual({ ok: false, reason: 'no_input' })
  })
})

/**
 * La FIGURE du clip vérifie le placement. C'est tout l'intérêt du 3e marqueur : avec 2 points,
 * n'importe quel écartement « est » 25 mm par définition, donc rien ne peut contredire une pose
 * approximative. Le triangle, lui, doit coller au rapport mesuré du clip (1,2313).
 */
describe('evalClipTriangle — la figure du clip contrôle le placement', () => {
  // Triangle conforme : base 25 mm, surélevée à 16/25 de la base au-dessus de son milieu.
  const base = 400
  const conforme = [
    { x: 1000, y: 500 },
    { x: 1000 + base, y: 500 },
    { x: 1000 + base / 2, y: 500 - (base * 16) / 25 },
  ]

  it('reconnaît le triangle du clip et trouve la base par la GÉOMÉTRIE', () => {
    const t = evalClipTriangle(conforme)
    expect(t.coherent).toBe(true)
    expect(t.basePx).toBeCloseTo(base, 0)
    expect(Math.abs(t.errPct)).toBeLessThan(1)
    expect(t.baseIndexes).toEqual([0, 1])
  })

  it('donne le même verdict quel que soit l’ORDRE des marqueurs posés', () => {
    for (const ordre of [[1, 2, 0], [2, 0, 1], [1, 0, 2]]) {
      const t = evalClipTriangle(ordre.map((i) => conforme[i]))
      expect(t.coherent, `ordre ${ordre}`).toBe(true)
      expect(t.basePx).toBeCloseTo(base, 0)
    }
  })

  it('REFUSE une figure qui n’est pas le triangle du clip', () => {
    const t = evalClipTriangle([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 200, y: -100 }])
    expect(t.coherent).toBe(false)
    expect(Math.abs(t.errPct)).toBeGreaterThan(8)
  })

  it('ne rend RIEN avec seulement 2 points (aucun contrôle possible)', () => {
    expect(evalClipTriangle([{ x: 0, y: 0 }, { x: 400, y: 0 }])).toBe(null)
    expect(evalClipTriangle([])).toBe(null)
    expect(evalClipTriangle(null)).toBe(null)
  })
})
