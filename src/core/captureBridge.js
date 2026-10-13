/**
 * Smart Optica — Captures venues de l'application Android.
 *
 * L'application ouvre l'interface de centrage en lui passant les deux photos qu'elle vient de
 * prendre, sous la forme `?face=<identifiant>&profile=<identifiant>`.
 *
 * Le point a comprendre : ces identifiants sont ceux de l'APPAREIL (`clientCaptureId`), pas ceux
 * du serveur. C'est l'application qui les genere, c'est donc tout ce qu'elle peut transmettre ;
 * le serveur, lui, designera ces captures par son propre identifiant. La premiere etape consiste
 * donc a faire resoudre l'un vers l'autre.
 *
 * Pourquoi les images sont telechargees et non affichees par leur adresse : la route qui sert un
 * fichier de capture exige un jeton. Une balise `<img src="...">` n'en envoie pas, et l'image
 * resterait vide sans message. On passe donc par `fetch`, qui porte l'en-tete, puis on fabrique
 * une adresse locale a partir des octets recus.
 */
import { getToken } from '../services/auth'
import { fetchWithTimeout } from './http'

export const PARAM_FACE = 'face'
export const PARAM_PROFILE = 'profile'

/** Identifiants de capture presents dans l'adresse, ou `null` s'ils sont absents. */
export function readCaptureIds(search) {
  const raw = search ?? (typeof window !== 'undefined' ? window.location.search : '')
  const params = new URLSearchParams(raw)
  const face = params.get(PARAM_FACE)
  const profile = params.get(PARAM_PROFILE)
  // Les DEUX sont exiges : le centrage digital ne peut rien faire d'une seule photo. En accepter
  // une seule ferait entrer dans le flux pour echouer plus loin, au moment de la mesure.
  if (!face || !profile) return null
  return { face, profile }
}

function authHeaders() {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Image d'une capture, designee par l'identifiant de l'APPAREIL.
 *
 * Deux appels : le serveur resout l'identifiant et rend l'adresse du fichier, puis on telecharge.
 * Les fusionner obligerait la route de l'image a accepter deux sortes d'identifiants — au moment
 * ou l'un des deux serait ambigu, on servirait la photo d'une autre capture.
 */
export async function fetchCaptureImage(clientCaptureId) {
  const res = await fetchWithTimeout(
    `/captures/by-client/${encodeURIComponent(clientCaptureId)}`,
    { headers: authHeaders() },
  )
  if (!res.ok) {
    const error = new Error(`Capture indisponible (HTTP ${res.status})`)
    error.status = res.status
    throw error
  }

  const summary = await res.json()
  if (!summary?.imageUrl) throw new Error('Capture sans image')

  const image = await fetchWithTimeout(summary.imageUrl, { headers: authHeaders() })
  if (!image.ok) throw new Error(`Image indisponible (HTTP ${image.status})`)

  return { url: URL.createObjectURL(await image.blob()), summary }
}

/**
 * Charge la paire face + profil, avec reprise.
 *
 * La reprise n'est pas un confort : l'envoi depuis le telephone passe par une file d'attente, et
 * l'opticien peut ouvrir le centrage avant qu'il ait abouti. Un 404 signifie alors « pas encore
 * recu » et non « perdu » — abandonner au premier essai lui ferait croire a une capture disparue,
 * et il reprendrait des photos qui sont deja la.
 *
 * Aucune autre erreur n'est reessayee : un 401 (session expiree) ou un 500 ne changeront pas en
 * attendant, et insister ne ferait qu'immobiliser l'ecran.
 */
export async function loadCapturePair(ids, { attempts = 6, delayMs = 1500 } = {}) {
  let derniere = null

  for (let essai = 1; essai <= attempts; essai++) {
    try {
      const [face, profile] = await Promise.all([
        fetchCaptureImage(ids.face),
        fetchCaptureImage(ids.profile),
      ])
      return {
        faceUrl: face.url,
        profileUrl: profile.url,
        face: face.summary,
        profile: profile.summary,
      }
    } catch (erreur) {
      derniere = erreur
      if (erreur?.status !== 404) break
      if (essai < attempts) await new Promise((r) => setTimeout(r, delayMs))
    }
  }

  throw derniere ?? new Error('Captures indisponibles')
}
