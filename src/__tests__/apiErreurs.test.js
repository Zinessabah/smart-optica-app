import { describe, it, expect, vi, afterEach } from 'vitest'
import { analyzeCalibration } from '../services/api'

// ⚠️ Ce fichier protège une distinction que rien ne testait, et dont l'absence a
// coûté plusieurs heures de diagnostic : l'écran de calibration présentait un
// HTTP 500 (le serveur a planté pendant l'analyse) comme une « détection
// infructueuse », donc l'opticien recadrait sa photo au lieu de réessayer.
//
// La distinction repose sur `err.status` : présent quand le serveur a RÉPONDU
// en erreur, absent quand il n'a pas répondu du tout. Ces trois cas doivent
// rester séparés — ne pas les fusionner en un seul message « API indisponible ».

const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })

function mockFetch(impl) {
  global.fetch = vi.fn(impl)
}

describe('analyzeCalibration — trois échecs, trois traitements', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete global.fetch
  })

  it('rend le corps de la réponse quand tout va bien', async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ markers: [{ x: 1, y: 2 }], spacing_px: 710.3 }),
    }))
    const res = await analyzeCalibration(blob)
    expect(res.spacing_px).toBeCloseTo(710.3)
    expect(res.markers).toHaveLength(1)
  })

  it('porte le code HTTP sur l’erreur quand le SERVEUR échoue (500)', async () => {
    mockFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    const err = await analyzeCalibration(blob).catch((e) => e)
    // Le code doit être LISIBLE par l'appelant, pas seulement dans le message.
    expect(err.status).toBe(500)
  })

  it('porte aussi les refus 4xx (photo inexploitable)', async () => {
    mockFetch(async () => ({ ok: false, status: 400, json: async () => ({}) }))
    const err = await analyzeCalibration(blob).catch((e) => e)
    expect(err.status).toBe(400)
  })

  it('ne porte AUCUN code quand le serveur est INJOIGNABLE', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    const err = await analyzeCalibration(blob).catch((e) => e)
    expect(err).toBeInstanceOf(TypeError)
    // C'est cette absence de `status` qui distingue « pas de réseau » de
    // « le serveur a répondu qu'il n'a pas pu ». Ne pas lui en donner un.
    expect(err.status).toBeUndefined()
  })
})
