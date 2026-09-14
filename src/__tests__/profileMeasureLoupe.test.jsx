import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, waitFor, configure } from '@testing-library/react'
import ProfileMeasure from '../ProfileMeasure'

configure({ asyncUtilTimeout: 3000 })

class FakeImage {
  set src(_v) {
    this.naturalWidth = 1000
    this.naturalHeight = 1333
    setTimeout(() => { if (this.onload) this.onload() }, 0)
  }
}

const CW = 480
const CH = 640

function mount() {
  vi.stubGlobal('Image', FakeImage)
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, right: CW, bottom: CH, width: CW, height: CH, toJSON() {} }
  }
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: CW })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: CH })
  return render(
    <ProfileMeasure imageUrl="blob:profil" calibrationScale={0.3}
      onCapture={() => {}} onSkip={() => {}} onBack={() => {}} />
  )
}

async function monterAvecAngle() {
  const utils = mount()
  await waitFor(() => expect(utils.container.querySelector('img')).toBeTruthy())
  const bouton = [...utils.container.querySelectorAll('button')].find((b) => /angle/i.test(b.textContent || ''))
  expect(bouton).toBeTruthy()
  fireEvent.click(bouton)
  await waitFor(() => expect(utils.container.querySelector('[data-pt-type="angle"][data-pt-index="1"]')).toBeTruthy())
  return utils
}

const sommetDe = (container) => container.querySelector('[data-pt-type="angle"][data-pt-index="1"]')

describe('ProfileMeasure — loupe sur l’angle pantoscopique', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('la loupe s’ouvre pendant le glissement d’une poignée de l’angle', async () => {
    const { container } = await monterAvecAngle()
    expect(container.querySelector('[data-loupe]')).toBeNull()
    fireEvent.pointerDown(sommetDe(container), { clientX: 300, clientY: 420 })
    await waitFor(() => expect(container.querySelector('[data-loupe]')).toBeTruthy())
    fireEvent.pointerUp(window)
  })

  it('elle se centre sur LE POINT MESURÉ, jamais sur la poignée déportée', async () => {
    const { container } = await monterAvecAngle()
    const sommet = sommetDe(container)
    // Le sommet a son octogone DÉPORTÉ : le doigt est à (300,420), le point est ailleurs.
    fireEvent.pointerDown(sommet, { clientX: 300, clientY: 420 })
    fireEvent.pointerMove(window, { clientX: 300, clientY: 420 })
    await waitFor(() => expect(container.querySelector('[data-loupe]')).toBeTruthy())

    const loupe = container.querySelector('[data-loupe]')
    const pctX = parseFloat(sommet.style.left) / 100
    const attendu = Math.min(Math.max(pctX * CW, 68), CW - 68)
    expect(Math.abs(parseFloat(loupe.style.left) - attendu)).toBeLessThan(3)
    // et surtout PAS la position du doigt : c'est ce que ferait un centrage naïf
    expect(Math.abs(parseFloat(loupe.style.left) - 300)).toBeGreaterThan(3)
    fireEvent.pointerUp(window)
  })

  it('elle grossit LE réticule du point, pas un dessin inventé', async () => {
    const { container } = await monterAvecAngle()
    fireEvent.pointerDown(sommetDe(container), { clientX: 300, clientY: 420 })
    await waitFor(() => expect(container.querySelector('[data-loupe]')).toBeTruthy())

    const loupe = container.querySelector('[data-loupe]')
    expect(loupe.textContent).toContain('Sommet')
    // Le réticule de cet écran : croix brisée (4 traits) + point central r=1,7
    expect(loupe.querySelectorAll('[data-reticle] line').length).toBe(4)
    expect(loupe.querySelector('[data-reticle] circle').getAttribute('r')).toBe('1.7')
    fireEvent.pointerUp(window)
  })

  it('elle affiche un champ en millimètres (échelle connue à cette étape)', async () => {
    const { container } = await monterAvecAngle()
    fireEvent.pointerDown(sommetDe(container), { clientX: 300, clientY: 420 })
    await waitFor(() => expect(container.querySelector('[data-loupe]')).toBeTruthy())
    const loupe = container.querySelector('[data-loupe]')
    // 8 mm visés : le champ est physique, il ne dépend pas de la résolution de la photo
    expect(loupe.textContent).toMatch(/8\s*mm/)
    fireEvent.pointerUp(window)
  })

  it('elle disparaît au relâchement', async () => {
    const { container } = await monterAvecAngle()
    fireEvent.pointerDown(sommetDe(container), { clientX: 300, clientY: 420 })
    await waitFor(() => expect(container.querySelector('[data-loupe]')).toBeTruthy())
    fireEvent.pointerUp(window)
    await waitFor(() => expect(container.querySelector('[data-loupe]')).toBeNull())
  })
})
