/**
 * Smart Optica — Pont vers l'application Android.
 *
 * ## Ce que ce module apporte
 *
 * Le bouton « Prendre 2 photos » de l'ecran d'accueil a deux vies :
 *
 *  - dans un NAVIGATEUR, il ouvre l'appareil photo du navigateur (`getUserMedia`) ;
 *  - dans l'APPLICATION ANDROID, l'appareil photo natif a niveaux est deja la, et il fait mieux :
 *    jauges a bulle, deux genres de capture, envoi vers le serveur. Refaire les photos dans la
 *    WebView serait un recul — et cela ne marcherait meme pas, `getUserMedia` exige un contexte
 *    securise que le service en HTTP ne fournit pas.
 *
 * L'application expose donc un pont (`window.SmartOpticaNative`). Ce module est le seul endroit
 * qui sait qu'il existe.
 *
 * ## La regle qui compte : le navigateur ne doit RIEN voir changer
 *
 * `isNativeApp()` est faux partout ailleurs que dans l'application. Toutes les fonctions d'ici
 * retombent alors sur leur comportement d'origine, et l'interface se comporte EXACTEMENT comme
 * avant. C'est la condition de non-regression de cette modification : le site continue de
 * fonctionner pour les iPads, les postes du bureau, et l'administration.
 *
 * ## Pourquoi `typeof` et non un simple test de verite
 *
 * Un pont absent donne `undefined` ; le lire sans precaution leve une exception dans un navigateur
 * ou `window` serait restreint. `typeof` ne declenche jamais cette lecture hasardeuse.
 */

/** Nom du pont expose par l'application Android. Doit correspondre a `NativeBridge.NAME` (Kotlin). */
export const NATIVE_BRIDGE = 'SmartOpticaNative'

/**
 * Sommes-nous dans l'application Android ?
 *
 * @returns {boolean} `true` uniquement si l'application a expose son pont.
 */
export function isNativeApp() {
  if (typeof window === 'undefined') return false
  const bridge = window[NATIVE_BRIDGE]
  return Boolean(bridge) && typeof bridge.takeTwoPhotos === 'function'
}

/**
 * Demande a l'application d'ouvrir l'appareil photo natif.
 *
 * @returns {boolean} `true` si la demande a ete transmise, `false` si aucun pont n'est present
 *   (cas du navigateur : l'appelant doit alors suivre son chemin habituel).
 */
export function requestNativePhotos() {
  if (!isNativeApp()) return false
  try {
    window[NATIVE_BRIDGE].takeTwoPhotos()
    return true
  } catch {
    // Pont present mais appel refuse : on rend `false` pour que l'appelant ne reste pas bloque
    // sur un geste qui n'a pas eu lieu. Un bouton mort est pire qu'un repli imparfait.
    return false
  }
}
