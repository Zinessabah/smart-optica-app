import { describe, it, expect } from 'vitest'
import { seedFromProfile, LATERAL_SPACING_MM } from './profileSeed'

/**
 * Réponse RÉELLE de /api/analyze-profile, relevée sur une photo de profil du projet
 * (backend/uploads/<user>/06f17b35-…_profile.png — cliché 4032×3024, EXIF orientation 6).
 * Le backend travaille après rotation : 3024×4032.
 */
const REPONSE_REELLE = {
  width: 3024,
  height: 4032,
  lateral_markers: [[2484, 989], [2455, 1227]],
  scale_mm_per_px: 0.0976,
  scale_from_markers_mm_per_px: 0.104271,
  scale_consistent: true,
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
    // L'écart détecté, lu à l'échelle des mires annoncée par le backend, vaut bien 25 mm
    expect(s.px).toBe(240)
    expect(s.px * REPONSE_REELLE.scale_from_markers_mm_per_px).toBeCloseTo(LATERAL_SPACING_MM, 0)
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

  it('REFUSE une échelle jugée invraisemblable par le backend', () => {
    expect(KO({ ...REPONSE_REELLE, scale_consistent: false }))
      .toEqual({ ok: false, reason: 'inconsistent_scale' })
  })

  it('n’exige PAS `scale_consistent` (champ absent d’un ancien backend)', () => {
    const { scale_consistent, ...sansChamp } = REPONSE_REELLE
    expect(scale_consistent).toBe(true)          // le champ existait bien dans la réponse
    expect(KO(sansChamp).ok).toBe(true)
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
