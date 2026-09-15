/**
 * Seuils de résolution — côté client.
 *
 * Le client refuse tôt (pour l'expérience), le serveur fait foi (sur les octets
 * reçus). Les deux DOIVENT porter la même valeur : sans ce test, ils dériveraient
 * en silence et une photo acceptée à l'écran serait refusée par le serveur.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  MIN_LONG_SIDE_FACE,
  MIN_LONG_SIDE_PROFILE,
  resolutionError,
} from './photoChecks'

describe('Contrat client ↔ serveur', () => {
  const py = readFileSync(new URL('../../backend/image_quality.py', import.meta.url), 'utf8')
  const constantePython = (nom) => {
    const m = new RegExp(`^${nom}\\s*=\\s*([0-9]+)`, 'm').exec(py)
    expect(m, `${nom} introuvable dans backend/image_quality.py`).toBeTruthy()
    return Number(m[1])
  }

  it('le seuil facial est le même des deux côtés', () => {
    expect(MIN_LONG_SIDE_FACE).toBe(constantePython('MIN_LONG_SIDE_FACE'))
  })

  it('le seuil latéral est le même des deux côtés', () => {
    expect(MIN_LONG_SIDE_PROFILE).toBe(constantePython('MIN_LONG_SIDE_PROFILE'))
  })

  it('le latéral est plus exigeant que le facial — 25 mm occupent moins de largeur que 50', () => {
    expect(MIN_LONG_SIDE_PROFILE).toBeGreaterThan(MIN_LONG_SIDE_FACE)
    expect(constantePython('MIN_LONG_SIDE_PROFILE')).toBeGreaterThan(
      constantePython('MIN_LONG_SIDE_FACE'))
  })
})

describe('Verdict de résolution', () => {
  it('accepte les photos réelles de l’iPad (4032×3024)', () => {
    expect(resolutionError(4032, 3024, 'face')).toBeNull()
    expect(resolutionError(4032, 3024, 'profile')).toBeNull()
  })

  it('accepte une photo faciale juste au seuil, refuse un pixel en dessous', () => {
    expect(resolutionError(MIN_LONG_SIDE_FACE, 1500, 'face')).toBeNull()
    expect(resolutionError(MIN_LONG_SIDE_FACE - 1, 1500, 'face')).not.toBeNull()
  })

  it('est insensible à l’orientation — portrait ou paysage, même verdict', () => {
    expect(resolutionError(3024, 4032, 'profile')).toBeNull()
    expect(resolutionError(4032, 3024, 'profile')).toBeNull()
    expect(resolutionError(1500, 1000, 'profile')).not.toBeNull()
    expect(resolutionError(1000, 1500, 'profile')).not.toBeNull()
  })

  it('refuse ce qui ne peut pas tenir ±0,5 mm', () => {
    expect(resolutionError(1280, 960, 'face')).not.toBeNull()
    expect(resolutionError(1920, 1080, 'face')).not.toBeNull()   // la voie vidéo
    expect(resolutionError(1920, 1080, 'profile')).not.toBeNull()
  })

  it('le message donne les dimensions mesurées ET le minimum attendu', () => {
    const msg = resolutionError(1280, 960, 'profile')
    expect(msg).toContain('1280×960')
    expect(msg).toContain(String(MIN_LONG_SIDE_PROFILE))
    expect(msg).toContain('latérale')
  })

  it('refuse des dimensions illisibles', () => {
    expect(resolutionError(0, 0, 'face')).not.toBeNull()
    expect(resolutionError(null, undefined, 'face')).not.toBeNull()
  })
})
