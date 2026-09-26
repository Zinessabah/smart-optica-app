/**
 * Smart Optica — appels réseau bornés dans le temps.
 *
 * Sans délai d'attente, une requête qui ne répond jamais fige l'écran POUR TOUJOURS :
 * pas d'erreur, pas de reprise, aucun moyen de savoir ce qui se passe. C'est ce qui
 * donne l'impression que l'application est bloquée alors que le serveur, lui, répond.
 *
 * On borne donc chaque appel, et l'expiration lève une erreur explicite que l'écran
 * peut montrer à l'utilisateur.
 */

/** Requêtes ordinaires : santé, authentification, listes, enregistrements. */
export const SHORT_TIMEOUT_MS = 20000

/** Analyses d'image : OpenCV côté backend, quelques secondes en temps normal. */
export const LONG_TIMEOUT_MS = 90000

/** Levée quand le serveur n'a pas répondu dans le délai imparti. */
export class RequestTimeoutError extends Error {
  constructor(url, delai) {
    super(
      `Le serveur n'a pas répondu en ${Math.round(delai / 1000)} s. ` +
        `Vérifiez votre connexion, puis réessayez.`
    )
    this.name = 'RequestTimeoutError'
    this.url = url
    this.delai = delai
  }
}

/**
 * Comme `fetch`, mais interrompt l'appel au bout de `delai` millisecondes.
 *
 * Note : le signal passé dans `options` est remplacé — l'appel doit rester
 * interruptible, c'est tout l'intérêt de la fonction.
 *
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} delai
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, delai = SHORT_TIMEOUT_MS) {
  const controleur = new AbortController()
  const minuteur = setTimeout(() => controleur.abort(), delai)

  try {
    return await fetch(url, { ...options, signal: controleur.signal })
  } catch (erreur) {
    if (erreur && erreur.name === 'AbortError') {
      throw new RequestTimeoutError(url, delai)
    }
    throw erreur
  } finally {
    clearTimeout(minuteur)
  }
}
