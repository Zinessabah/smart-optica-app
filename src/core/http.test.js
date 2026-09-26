/**
 * Verrous du garde-fou temporel des appels réseau.
 *
 * L'application n'avait aucun délai d'attente : un appel sans réponse figeait l'écran
 * indéfiniment. Ces tests garantissent que l'appel est bien interrompu, que l'erreur
 * produite est identifiable et lisible, et qu'aucun minuteur ne reste en suspens.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fetchWithTimeout,
  RequestTimeoutError,
  SHORT_TIMEOUT_MS,
  LONG_TIMEOUT_MS,
} from './http'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('fetchWithTimeout', () => {
  it('laisse passer une réponse rapide, telle quelle', async () => {
    const reponse = { ok: true, status: 200 }
    const espion = vi.fn().mockResolvedValue(reponse)
    vi.stubGlobal('fetch', espion)

    const resultat = await fetchWithTimeout('/api/test')

    expect(resultat).toBe(reponse)
    expect(espion).toHaveBeenCalledTimes(1)
  })

  it('interrompt un appel qui ne répond jamais et lève une erreur explicite', async () => {
    vi.useFakeTimers()
    // Une promesse qui ne se résout jamais, mais qui réagit à l'abandon.
    vi.stubGlobal('fetch', (url, options) =>
      new Promise((_resoudre, rejeter) => {
        options.signal.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          rejeter(e)
        })
      })
    )

    const appel = fetchWithTimeout('/api/lent', {}, 5000)
    const verif = expect(appel).rejects.toBeInstanceOf(RequestTimeoutError)
    await vi.advanceTimersByTimeAsync(5000)
    await verif
  })

  it("l'erreur porte le délai et l'adresse, et se lit en français", async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', (url, options) =>
      new Promise((_resoudre, rejeter) => {
        options.signal.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          rejeter(e)
        })
      })
    )

    const appel = fetchWithTimeout('/api/analyse', {}, SHORT_TIMEOUT_MS)
    const verif = appel.catch((e) => e)
    await vi.advanceTimersByTimeAsync(SHORT_TIMEOUT_MS)
    const erreur = await verif

    expect(erreur.name).toBe('RequestTimeoutError')
    expect(erreur.delai).toBe(SHORT_TIMEOUT_MS)
    expect(erreur.url).toBe('/api/analyse')
    expect(erreur.message).toContain('20 s')
  })

  it('ne transforme pas une panne réseau en expiration', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    await expect(fetchWithTimeout('/api/test')).rejects.toBeInstanceOf(TypeError)
  })

  it('libère son minuteur : aucun ne reste en suspens après un succès', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    await fetchWithTimeout('/api/test')

    expect(vi.getTimerCount()).toBe(0)
  })

  it('libère son minuteur : aucun ne reste en suspens après une expiration', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', (url, options) =>
      new Promise((_resoudre, rejeter) => {
        options.signal.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          rejeter(e)
        })
      })
    )

    const appel = fetchWithTimeout('/api/lent', {}, 1000).catch((e) => e)
    await vi.advanceTimersByTimeAsync(1000)
    await appel

    expect(vi.getTimerCount()).toBe(0)
  })

  it('transmet bien un signal interruptible à fetch', async () => {
    const espion = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', espion)

    await fetchWithTimeout('/api/test', { method: 'POST' }, 1234)

    const options = espion.mock.calls[0][1]
    expect(options.method).toBe('POST')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.signal.aborted).toBe(false)
  })

  it('délai long nettement supérieur au délai court', () => {
    expect(LONG_TIMEOUT_MS).toBeGreaterThan(SHORT_TIMEOUT_MS * 3)
  })
})
