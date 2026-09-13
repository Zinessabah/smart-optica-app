import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import PupilMarker from '../PupilMarker'

/**
 * Contrôles objectifs de l'écran facial.
 * Principe : ils CONSTATENT, ils ne corrigent rien — et ils ne doivent jamais
 * annoncer « conforme » sur un point qui n'a pas pu être vérifié.
 * Les repères sont fournis via les props initial* → géométrie déterministe,
 * aucune auto-détection ne vient écraser le scénario.
 */

function stubImageLoad(w = 1000, h = 1333) {
  class FakeImage {
    set src(_v) {
      this.naturalWidth = w
      this.naturalHeight = h
      setTimeout(() => { if (this.onload) this.onload() }, 0)
    }
  }
  vi.stubGlobal('Image', FakeImage)
}

const IW = 1000
const IH = 1333

// Jeu de repères « propre » : pupilles à la même hauteur, pont pile au milieu
const EYES_LEVEL = { initialLeftEye: { x: 400, y: 500 }, initialRightEye: { x: 600, y: 500 }, initialBridge: { x: 500, y: 760 } }

describe('PupilMarker — contrôles objectifs', () => {
  beforeEach(() => {
    stubImageLoad(IW, IH)
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 533, width: 400, height: 533, toJSON() {} }
    }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 533 })
  })
  afterEach(() => vi.unstubAllGlobals())

  async function mount(calibration = { scalePxToMm: 0.25 }, initials = EYES_LEVEL) {
    const utils = render(
      <PupilMarker imageUrl="blob:fake" calibration={calibration} {...initials}
        onConfirm={() => {}} onBack={() => {}} />
    )
    const { container } = utils
    await waitFor(() => expect(container.querySelector('[data-quality-panel="1"]')).toBeTruthy())
    // Le panneau s'affiche avant l'image : attendre que les repères soient posés
    if (initials.initialLeftEye) {
      await waitFor(() => expect(container.querySelector('[data-markerid="left"]')).toBeTruthy())
    }
    return utils
  }

  const check = (container, id) => container.querySelector(`[data-quality="${id}"]`)
  const level = (container, id) => check(container, id).getAttribute('data-level')

  it('le panneau de contrôles est présent avec ses 5 points', async () => {
    const { container } = await mount()
    for (const id of ['calib', 'sharp', 'roll', 'bridge', 'edge']) {
      expect(check(container, id), `contrôle « ${id} » manquant`).toBeTruthy()
    }
  })

  it('sans calibrage physique → verdict bloquant', async () => {
    const { container } = await mount(null)
    expect(level(container, 'calib')).toBe('bad')
    expect(check(container, 'calib').textContent).toContain('aucune mesure en mm')
  })

  it('netteté non analysable → jamais annoncée conforme', async () => {
    // En jsdom le canvas est indisponible : l'analyse doit se déclarer « en cours »,
    // JAMAIS « ok » — un contrôle non fait ne vaut pas un contrôle réussi.
    const { container } = await mount()
    expect(level(container, 'sharp')).toBe('warn')
    expect(check(container, 'sharp').textContent).toContain('en cours')
  })

  it('repères absents → contrôles en attente, jamais de faux « ok »', async () => {
    const { container } = await mount({ scalePxToMm: 0.25 }, {})
    expect(level(container, 'roll')).toBe('warn')
    expect(check(container, 'roll').textContent).toContain('placez les deux pupilles')
    expect(level(container, 'bridge')).toBe('warn')
  })

  it('axe interpupillaire horizontal → conforme, avec la valeur en degrés', async () => {
    const { container } = await mount()
    expect(level(container, 'roll')).toBe('ok')
    expect(check(container, 'roll').textContent).toMatch(/\d+\.\d°/)
  })

  it('tête inclinée de 10,6° → avertissement chiffré', async () => {
    const { container } = await mount({ scalePxToMm: 0.25 }, {
      ...EYES_LEVEL, initialRightEye: { x: 600, y: 537 },   // atan(37/200) ≈ 10,5°
    })
    expect(level(container, 'roll')).toBe('warn')
    expect(check(container, 'roll').textContent).toContain('10')
  })

  it('pont centré → conforme ; pont très décalé → tête tournée / repère décalé', async () => {
    const centred = await mount()
    expect(level(centred.container, 'bridge')).toBe('ok')

    const skewed = await mount({ scalePxToMm: 0.25 }, { ...EYES_LEVEL, initialBridge: { x: 800, y: 760 } })
    expect(level(skewed.container, 'bridge')).toBe('warn')
    expect(check(skewed.container, 'bridge').textContent).toContain('tête tournée')
  })

  it('repère collé au bord → signalé comme rogné', async () => {
    const { container } = await mount({ scalePxToMm: 0.25 }, {
      ...EYES_LEVEL, initialLeftEye: { x: 0, y: 500 },
    })
    expect(level(container, 'edge')).toBe('warn')
    expect(check(container, 'edge').textContent).toContain('bord')
  })

  it('le résumé compte exactement les points non conformes', async () => {
    const { container } = await mount(null)
    const issues = container.querySelectorAll('[data-level="warn"], [data-level="bad"]').length
    // Le résumé porte le même nombre que les lignes affichées
    expect(container.querySelector('[data-quality-panel="1"]').textContent).toContain(`${issues} point`)
    expect(issues).toBeGreaterThan(0)
  })
})
