/**
 * Tests de la passerelle entre l'application Android et l'interface.
 *
 * Ce qui est protege ici n'est pas une conversion, c'est une SEQUENCE : resolution de
 * l'identifiant de l'appareil, telechargement de l'image avec le jeton, et surtout la REPRISE.
 * L'envoi depuis le telephone passe par une file d'attente : au moment ou l'opticien ouvre le
 * centrage, la capture n'est pas toujours arrivee. Sans reprise, il verrait « photos
 * indisponibles » et reprendrait des photos qui sont deja la.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { readCaptureIds, fetchCaptureImage, loadCapturePair } from './captureBridge'

// `URL.createObjectURL` n'existe pas en environnement de test : sans ce substitut, on testerait
// l'absence de l'API du navigateur au lieu de la logique de la passerelle.
const createObjectURL = vi.fn(() => 'blob:capture')

// Les tests unitaires tournent en environnement NODE, pas en jsdom : on fournit donc le strict
// necessaire — le stockage du jeton, que `getToken()` lit. Le simuler evite de dependre de jsdom
// (non installe ici) pour deux lignes.
beforeEach(() => {
  const store = {}
  vi.stubGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
  })
  localStorage.setItem('so_token', 'jeton-de-test')
  globalThis.URL.createObjectURL = createObjectURL
  createObjectURL.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function reponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob(['octets']),
  }
}

describe('readCaptureIds', () => {
  it('rend les deux identifiants quand ils sont la', () => {
    expect(readCaptureIds('?face=f1&profile=p1')).toEqual({ face: 'f1', profile: 'p1' })
  })

  it('exige les DEUX identifiants', () => {
    // Une seule photo ne permet pas de centrer : entrer dans le flux pour echouer au moment de
    // la mesure ferait perdre plus de temps que refuser tout de suite.
    expect(readCaptureIds('?face=f1')).toBeNull()
    expect(readCaptureIds('?profile=p1')).toBeNull()
    expect(readCaptureIds('')).toBeNull()
  })
})

describe('fetchCaptureImage', () => {
  it('resout l identifiant puis telecharge l image avec le jeton', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reponse(200, { imageUrl: '/captures/abc/image' }))
      .mockResolvedValueOnce(reponse(200, null))
    vi.stubGlobal('fetch', fetchMock)

    const resultat = await fetchCaptureImage('client-1')

    // Deux appels : le serveur resout, puis on telecharge. Les fusionner obligerait la route de
    // l'image a accepter deux sortes d'identifiants — ambigu le jour ou les deux se croisent.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('/captures/by-client/client-1')
    expect(fetchMock.mock.calls[1][0]).toBe('/captures/abc/image')
    // Le jeton doit partir sur LES DEUX : la route de l'image l'exige aussi.
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jeton-de-test')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer jeton-de-test')
    expect(resultat.url).toBe('blob:capture')
  })

  it('remonte le code HTTP, pour que l appelant distingue 404 et 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reponse(404, { code: 'capture_inconnue' })))

    await expect(fetchCaptureImage('inconnu')).rejects.toMatchObject({ status: 404 })
  })
})

describe('loadCapturePair', () => {
  it('reprend quand la capture n est pas encore arrivee', async () => {
    // Sequence reelle : l'envoi n'a pas encore abouti (404), puis aboutit.
    //
    // La reponse depend de l'ADRESSE et non d'un ordre d'appel : les deux photos sont chargees en
    // parallele, et un scenario ecrit en « une reponse apres l'autre » dependrait de leur
    // entrelacement — il passerait ou echouerait selon l'ordonnancement, ce qui n'est pas un test.
    let resolutions = 0
    const fetchMock = vi.fn(async (url) => {
      if (!url.includes('/by-client/')) return reponse(200, null)      // l'image elle-meme
      resolutions++
      if (resolutions <= 2) return reponse(404, {})                    // pas encore arrivee
      const id = url.split('/by-client/')[1]
      return reponse(200, { imageUrl: `/captures/${id}/image` })
    })
    vi.stubGlobal('fetch', fetchMock)

    const paire = await loadCapturePair({ face: 'f', profile: 'p' }, { attempts: 3, delayMs: 1 })

    expect(paire.faceUrl).toBe('blob:capture')
    expect(paire.profileUrl).toBe('blob:capture')
  })

  it('ne reprend PAS sur une session expiree', async () => {
    // Un 401 ne changera pas en attendant : insister ferait patienter l'opticien devant un ecran
    // qui ne peut pas aboutir.
    const fetchMock = vi.fn().mockResolvedValue(reponse(401, { detail: 'Jeton expiré' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      loadCapturePair({ face: 'f', profile: 'p' }, { attempts: 5, delayMs: 1 }),
    ).rejects.toMatchObject({ status: 401 })

    // Un seul essai : deux appels (face et profil), pas dix.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('abandonne apres le nombre d essais prevu', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reponse(404, {}))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      loadCapturePair({ face: 'f', profile: 'p' }, { attempts: 2, delayMs: 1 }),
    ).rejects.toMatchObject({ status: 404 })

    // 2 essais x 2 photos.
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
