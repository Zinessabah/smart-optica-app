/**
 * Vérité de la détection — contenu informatif, pas décoratif.
 *
 * Règle (héritée des contrôles objectifs) : un état non encore connu ne s'annonce
 * jamais « ok », et un REPLI est DIT. Chaque état n'est affiché qu'UNE fois :
 * échec et proportions par les bandeaux existants, méthode réelle par l'indicateur.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, configure } from '@testing-library/react'
import PupilMarker from '../PupilMarker'
import { detectFace } from '../core/faceDetection'

configure({ asyncUtilTimeout: 3000 })

vi.mock('../core/faceDetection.js', () => ({ detectFace: vi.fn() }))

class FakeImage {
  set src(_v) {
    this.naturalWidth = 1000
    this.naturalHeight = 1333
    setTimeout(() => { if (this.onload) this.onload() }, 0)
  }
}

function mount() {
  vi.stubGlobal('Image', FakeImage)
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, right: 480, bottom: 640, width: 480, height: 640, toJSON() {} }
  }
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 480 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 640 })
  return render(
    <PupilMarker imageUrl="blob:face" calibration={{ scalePxToMm: 0.3 }}
      onConfirm={() => {}} onBack={() => {}} />
  )
}

const indicateur = (c) => c.querySelector('[data-detect="method"]')

describe('Vérité de la détection', () => {
  beforeEach(() => { vi.mocked(detectFace).mockReset() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('annonce face-api AVEC son score — la donnée existait, elle est enfin montrée', async () => {
    vi.mocked(detectFace).mockResolvedValue({
      leftEye: { x: 300, y: 400 }, rightEye: { x: 700, y: 400 }, nose: { x: 500, y: 500 },
      method: 'face-api', score: 0.87,
    })
    const { container } = mount()
    await waitFor(() => expect(indicateur(container)).toBeTruthy())
    expect(indicateur(container).textContent).toContain('face-api')
    expect(indicateur(container).textContent).toContain('0.87')
  })

  it('distingue l’API du navigateur SANS repères (boîte englobante) d’une vraie détection', async () => {
    vi.mocked(detectFace).mockResolvedValue({
      leftEye: { x: 300, y: 400 }, rightEye: { x: 700, y: 400 }, nose: { x: 500, y: 500 },
      method: 'native', nativeQuality: 'bbox', score: null,
    })
    const { container } = mount()
    await waitFor(() => expect(indicateur(container)).toBeTruthy())
    // Le point clé : ne PAS annoncer « détection du navigateur » sur une déduction
    expect(indicateur(container).textContent).toMatch(/boîte/)
    expect(indicateur(container).textContent).toMatch(/approximatif/)
  })

  it('dit le repli par proportions au lieu de le faire passer pour une réussite', async () => {
    vi.mocked(detectFace).mockResolvedValue({
      leftEye: { x: 300, y: 400 }, rightEye: { x: 700, y: 400 }, nose: { x: 500, y: 500 },
      method: 'proportions', score: null,
    })
    const { container } = mount()
    // Bandéau existant, conservé : pas de doublon, et le mot « proportion » est explicite
    await waitFor(() => expect(container.textContent).toMatch(/proportion/))
    expect(container.textContent).toMatch(/repositionnez/)
  })

  it('n’annonce RIEN tant que la détection est en cours', async () => {
    let liberer
    vi.mocked(detectFace).mockImplementation(() => new Promise((r) => { liberer = r }))
    const { container } = mount()
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    await new Promise((r) => setTimeout(r, 50))
    // Aucun « face-api » ni « repères du navigateur » tant qu'on ne sait pas
    expect(indicateur(container)).toBeNull()
    liberer({ leftEye: { x: 1, y: 1 }, rightEye: { x: 2, y: 2 }, nose: null, method: 'native', nativeQuality: 'landmarks' })
    await waitFor(() => expect(indicateur(container)).toBeTruthy())
    expect(indicateur(container).textContent).toMatch(/navigateur/)
  })

  it('annonce l’échec de la cascade', async () => {
    vi.mocked(detectFace).mockResolvedValue(null)
    const { container } = mount()
    await waitFor(() => expect(container.textContent).toMatch(/impossible/))
  })
})
