/**
 * Tests du pont Android.
 *
 * Deux choses comptent ici, et la seconde davantage que la premiere :
 *
 *  1. dans l'application, le pont est bien appele ;
 *  2. dans un NAVIGATEUR (pas de pont), RIEN ne change : c'est la condition de non-regression de
 *     toute cette modification. Un test qui ne verifierait que le cas application laisserait
 *     passer une regression sur le site, qui est utilise tous les jours.
 *
 * L'environnement de test est `node` (voir `vitest.config.js`), donc sans `window` : on installe
 * un `window` minimal avec `vi.stubGlobal`, comme le fait `captureBridge.test.js`. Cela teste au
 * passage le cas reel d'un contexte sans `window` (rendu serveur, environnement restreint).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { isNativeApp, requestNativePhotos, NATIVE_BRIDGE } from './nativeBridge'

/** Installe un `window` nu, comme celui d'un navigateur ordinaire. */
function withWindow(value = {}) {
  vi.stubGlobal('window', value)
  return value
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pont natif — cote navigateur', () => {
  it("n'est PAS l'application quand aucun pont n'est expose", () => {
    withWindow()
    expect(isNativeApp()).toBe(false)
  })

  it('rend false au lieu de lever une exception', () => {
    withWindow()
    expect(() => requestNativePhotos()).not.toThrow()
    expect(requestNativePhotos()).toBe(false)
  })

  it('ne leve pas non plus quand `window` est absent (contexte restreint)', () => {
    // Cas reel : le module est evalue dans un environnement sans DOM. Le lire sans precaution
    // ferait echouer le rendu entier pour une fonctionnalite qui n'existe pas la.
    expect(isNativeApp()).toBe(false)
    expect(requestNativePhotos()).toBe(false)
  })

  it('ignore un objet portant le bon nom mais sans la bonne methode', () => {
    // Un site pourrait definir `window.SmartOpticaNative` pour autre chose. Sans ce controle,
    // on appellerait une methode qui n'existe pas — et le bouton echouerait silencieusement.
    withWindow({ [NATIVE_BRIDGE]: { autreChose: () => {} } })
    expect(isNativeApp()).toBe(false)
    expect(requestNativePhotos()).toBe(false)
  })
})

describe('pont natif — cote application', () => {
  it('detecte le pont et transmet la demande', () => {
    const takeTwoPhotos = vi.fn()
    withWindow({ [NATIVE_BRIDGE]: { takeTwoPhotos } })

    expect(isNativeApp()).toBe(true)
    expect(requestNativePhotos()).toBe(true)
    expect(takeTwoPhotos).toHaveBeenCalledTimes(1)
  })

  it('rend false si le pont echoue, pour ne pas bloquer le bouton', () => {
    withWindow({ [NATIVE_BRIDGE]: { takeTwoPhotos: () => { throw new Error('refus') } } })

    // Un pont present mais en echec ne doit PAS laisser l'utilisateur devant un bouton mort :
    // `false` indique a l'appelant qu'il doit suivre son propre chemin.
    expect(requestNativePhotos()).toBe(false)
  })
})
