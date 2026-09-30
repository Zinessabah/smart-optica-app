import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import ProfileMeasure from '../ProfileMeasure'

/**
 * Barre d'outils de l'écran « Mesures latérales » (choix Driss) :
 *   4 boutons INTERRUPTEURS — ils activent ET désactivent l'outil.
 *     · 📏 Échelle   → les 2 marqueurs ; affiche les px/mm mesurés entre eux
 *     · 📐 Réglette  → la réglette métrologique
 *     · ↔ Vertex     → les 2 poignées du vertex
 *     · ∠ Angle pantoscopique → les 3 poignées de l'angle
 */

function stubImageLoad(w = 1000, h = 1333) {
  class FakeImage {
    set src(_v) {
      this.naturalWidth = w
      this.naturalHeight = h
      if (this.onload) this.onload()
    }
  }
  vi.stubGlobal('Image', FakeImage)
}

describe('ProfileMeasure — barre d’outils', () => {
  beforeEach(() => {
    stubImageLoad()
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 533, width: 400, height: 533, toJSON() {} }
    }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 533 })
  })
  afterEach(() => vi.unstubAllGlobals())

  const renderPM = () =>
    render(<ProfileMeasure imageUrl="blob:fake" onCapture={() => {}} onSkip={() => {}} onBack={() => {}} />)

  const btn = (container, label) =>
    [...container.querySelectorAll('button')].find(b => (b.textContent || '').includes(label))
  const clickTool = (container, label) => fireEvent.click(btn(container, label))
  // Actif = le style porte une vraie couleur de liseré (sinon « transparent »)
  const isOn = (b) => !(b.getAttribute('style') || '').includes('transparent')

  async function placePoints(clicks) {
    const utils = renderPM()
    const { container } = utils
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    const stage = container.querySelector('.aspect-\\[3\\/4\\]')
    for (const [x, y] of clicks) {
      fireEvent.pointerDown(stage, { clientX: x, clientY: y })
      fireEvent.click(stage, { clientX: x, clientY: y })
    }
    return { ...utils, stage }
  }
  const MIRES = [[100, 150], [300, 160]]
  const withMires = () => placePoints(MIRES)
  // Place DÉLIBÉRÉMENT les 3 marqueurs en DÉCALANT la figure entière : c'est ce que fait
  // l'utilisateur — il amène le triangle sur les mires sans le déformer. Un déplacement différent
  // par marqueur casserait la figure, et l'app le refuserait (c'est le contrôle qui a été ajouté).
  const placerLesMarqueurs = (container) => {
    ;[...container.querySelectorAll('[data-pt-type="verify"]')].forEach((h) => {
      fireEvent.pointerDown(h, { clientX: 100, clientY: 150 })
      fireEvent.pointerMove(window, { clientX: 130, clientY: 160 })
      fireEvent.pointerUp(window, { clientX: 130, clientY: 160 })
    })
  }

  // Pose DÉLIBÉRÉMENT les points de l'angle, par un décalage IDENTIQUE (la figure est translatée,
  // donc l'angle mesuré ne change pas).
  const placerLesPointsDangle = (container) => {
    ;[...container.querySelectorAll('[data-pt-type="angle"]')].forEach((h) => {
      fireEvent.pointerDown(h, { clientX: 100, clientY: 150 })
      fireEvent.pointerMove(window, { clientX: 130, clientY: 160 })
      fireEvent.pointerUp(window, { clientX: 130, clientY: 160 })
    })
  }

  it('on a bien les 4 boutons demandés, présents dès le début', async () => {
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())

    for (const label of ['Échelle', 'Réglette', 'Vertex', 'Angle pantoscopique']) {
      expect(btn(container, label), `bouton « ${label} » manquant`).toBeTruthy()
    }
    expect(btn(container, 'Angle pantoscopique').textContent).toContain('—')
    expect(btn(container, 'Vertex').textContent).toContain('—')
  })

  it("à l'arrivée, SEULE l'Échelle est active (les 3 autres s'activent à la demande)", async () => {
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())

    expect(isOn(btn(container, 'Échelle'))).toBe(true)
    expect(isOn(btn(container, 'Réglette'))).toBe(false)
    expect(isOn(btn(container, 'Vertex'))).toBe(false)
    expect(isOn(btn(container, 'Angle pantoscopique'))).toBe(false)
  })

  it('la Réglette s’active à la demande', async () => {
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(3))
    // La réglette ne se dessine qu'avec une échelle MESURÉE : une longueur en mm calculée sur
    // les positions de départ provisoires serait fausse.
    placerLesMarqueurs(container)

    clickTool(container, 'Réglette')
    await waitFor(() => expect(isOn(btn(container, 'Réglette'))).toBe(true))
    await waitFor(() => expect(container.querySelector('.mr-ruler')).toBeTruthy())

    clickTool(container, 'Réglette')
    await waitFor(() => expect(container.querySelector('.mr-ruler')).toBeFalsy())
  })

  it("n'affiche AUCUNE échelle tant que les poignées n'ont pas été mesurées", async () => {
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    // Les 3 marqueurs existent bien dès l'arrivée (l'écran n'est pas vide), mais leurs positions
    // de départ sont PROVISOIRES : leur écartement ne mesure rien, donc aucun nombre à l'écran.
    // Mesuré sur une photo de 4032 px de large : ces positions donnaient « 22,56 px/mm » alors
    // que les vraies mires valaient 16,11 px/mm (facteur 1,40) — sans que rien ne le signale.
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(3))
    expect(container.textContent).not.toMatch(/\d+\.\d+ px\/mm/)
    expect(container.textContent).toContain('—')
  })

  it("un simple appui sur une poignée ne légitime PAS l'échelle (frémissement du doigt)", async () => {
    // Même géométrie que l'iPad : photo 4032 px de large affichée dans ~400 px → 1 px client
    // vaut ~10 px image, donc bien au-delà du seuil de drag de 3 px IMAGE.
    stubImageLoad(4032, 3024)
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(3))
    const h = container.querySelector('[data-pt-type="verify"]')
    // Un appui iOS produit toujours quelques pixels de mouvement : ce n'est pas un placement,
    // l'échelle doit rester au tiret.
    fireEvent.pointerDown(h, { clientX: 100, clientY: 150 })
    fireEvent.pointerMove(window, { clientX: 101, clientY: 150 })
    fireEvent.pointerUp(window, { clientX: 101, clientY: 150 })
    expect(container.textContent).not.toMatch(/\d+\.\d+ px\/mm/)
    expect(container.textContent).toContain('—')
  })

  it("affiche les px/mm dès que l'utilisateur a placé les 3 marqueurs", async () => {
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(3))
    placerLesMarqueurs(container)
    // Les 3 marqueurs placés = une mesure de l'utilisateur : l'échelle devient légitime
    await waitFor(() => expect(container.textContent).toMatch(/\d+\.\d+ px\/mm/))
  })

  it("REFUSE l'échelle quand les 3 marqueurs ne forment PAS le triangle du clip", async () => {
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(3))
    // Chaque marqueur décalé d'une quantité DIFFÉRENTE : la figure est cassée, comme un utilisateur
    // qui poserait ses marqueurs n'importe où. Avec 2 points on ne pourrait pas le voir ; le
    // triangle, si — et l'app doit le DIRE plutôt que d'afficher une échelle.
    const decalages = [[10, 0], [10, 0], [60, 0]]
    ;[...container.querySelectorAll('[data-pt-type="verify"]')].forEach((h, i) => {
      const [dx, dy] = decalages[i]
      fireEvent.pointerDown(h, { clientX: 100, clientY: 150 })
      fireEvent.pointerMove(window, { clientX: 100 + dx, clientY: 150 + dy })
      fireEvent.pointerUp(window, { clientX: 100 + dx, clientY: 150 + dy })
    })
    await waitFor(() => expect(container.textContent).toMatch(/triangle à/))
    // Aucune échelle nulle part dans l'écran : le placement est déclaré non conforme.
    expect(container.textContent).not.toMatch(/\d+\.\d+ px\/mm/)
  })

  it("désactiver puis réactiver l'Échelle garde ses 3 marqueurs", async () => {
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(3))

    clickTool(container, 'Échelle')
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(0))
    clickTool(container, 'Échelle')
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(3))
  })

  it("le bouton Angle pantoscopique active PUIS désactive les 3 poignées", async () => {
    const { container } = await withMires()
    expect(container.querySelectorAll('[data-pt-type="angle"]').length).toBe(0)

    clickTool(container, 'Angle pantoscopique')
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="angle"]').length).toBe(3))
    expect(isOn(btn(container, 'Angle pantoscopique'))).toBe(true)

    clickTool(container, 'Angle pantoscopique')          // on désactive
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="angle"]').length).toBe(0))
    expect(isOn(btn(container, 'Angle pantoscopique'))).toBe(false)
  })

  it("le bouton Vertex active puis désactive les 2 poignées", async () => {
    const { container } = await withMires()
    clickTool(container, 'Vertex')
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="vertex"]').length).toBe(2))

    clickTool(container, 'Vertex')
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="vertex"]').length).toBe(0))
  })

  it("désactiver l'échelle masque ses 2 marqueurs", async () => {
    const { container } = await withMires()
    expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(3)

    clickTool(container, 'Échelle')
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(0))
  })

  it('les mesures restent affichées quand on masque l’outil', async () => {
    const { container } = await withMires()
    clickTool(container, 'Angle pantoscopique')
    // Les positions de DÉPART ne mesurent rien : l'app affiche le tiret tant que la ligne du verre
    // n'a pas été POSÉE (même règle que l'échelle).
    expect(btn(container, 'Angle pantoscopique').textContent).toContain('—')
    placerLesPointsDangle(container)
    await waitFor(() => expect(btn(container, 'Angle pantoscopique').textContent).toMatch(/\d+(\.\d+)?°/))

    const av = btn(container, 'Angle pantoscopique').textContent
    clickTool(container, 'Angle pantoscopique')   // masqué
    expect(btn(container, 'Angle pantoscopique').textContent).toBe(av)
  })

  it("le tap ne pose un point que pour un outil ACTIF (l'angle est désactivé par défaut)", async () => {
    const { container } = await placePoints([[100, 150], [300, 160], [120, 420]])
    expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(3)
    expect(container.querySelectorAll('[data-pt-type="angle"]').length).toBe(0)
  })
})
