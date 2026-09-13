import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, configure } from '@testing-library/react'

// Marge de manœuvre : jsdom sous charge peut dépasser le délai par défaut de 1 s.
// Les assertions restent identiques — seul le temps d'attente change.
configure({ asyncUtilTimeout: 3000 })
import PupilMarker from '../PupilMarker'

// Détection automatique neutralisée : elle résout `null` (échec franc), donc
// aucun repère n'est posé et aucun timer de 15 s ne reste en suspens.
// On teste ainsi le placement MANUEL de façon déterministe.
vi.mock('../core/faceDetection', () => ({ detectFace: async () => null }))

/**
 * Barre de commandes de l'écran facial — après suppression des boutons de
 * sélection. Ce qui est vérifié :
 *  - les boutons de sélection des REPÈRES ont disparu (Centre du Nez / OD / OG)
 *  - les boutons BOX OD / BOX OG sont CONSERVÉS : dans BoxingRect, la croix de
 *    déplacement et les 16 poignées ne sont rendues que sous `{active && …}`,
 *    donc sans sélection les boîtes ne peuvent plus être bougées
 *  - un tap pose LE PREMIER repère manquant, dans l'ordre Pont → OD → OG
 *  - une fois tout posé, un tap à côté ne modifie plus rien
 *  - la ligne de pastilles montre l'état (— / ✓ / 🔒) et sert de verrou
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

const CW = 400
const CH = 533

describe('PupilMarker — barre de commandes', () => {
  beforeEach(() => {
    stubImageLoad()
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, left: 0, top: 0, right: CW, bottom: CH, width: CW, height: CH, toJSON() {} }
    }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: CW })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: CH })
  })
  afterEach(() => vi.unstubAllGlobals())

  async function mount() {
    const utils = render(
      <PupilMarker imageUrl="blob:fake" calibration={{ scalePxToMm: 0.25 }}
        onConfirm={() => {}} onBack={() => {}} />
    )
    const { container } = utils
    await waitFor(() => expect(container.querySelector('#pupil-image-container')).toBeTruthy())
    const stage = container.querySelector('#pupil-image-container')

    // Le conteneur est rendu AVANT que `imageSize` soit connu : un tap trop tôt
    // est ignoré (comportement voulu de l'app). On réessaie donc le MÊME tap
    // jusqu'à ce que le repère apparaisse — le relancer est sûr, car un tap pose
    // toujours le PREMIER repère manquant (Pont → OD → OG).
    const tap = async (sel, x, y) => {
      await waitFor(() => {
        fireEvent.pointerDown(stage, { clientX: x, clientY: y })
        fireEvent.pointerUp(stage, { clientX: x, clientY: y })
        expect(container.querySelector(sel)).toBeTruthy()
      }, { timeout: 5000, interval: 100 })
    }
    const chip = (key) => container.querySelector(`[data-chip="${key}"]`)
    const marker = (id) => container.querySelector(`[data-markerid="${id}"]`)
    return { ...utils, container, stage, tap, chip, marker }
  }

  it('un seul type de bouton : 5 pastilles identiques, aucune bouton de sélection', async () => {
    const { container } = await mount()
    const chips = [...container.querySelectorAll('[data-chip]')].map(c => c.getAttribute('data-chip'))
    expect(chips).toEqual(['bridge', 'left', 'right', 'boxOG', 'boxOD'])
    // Toutes bâties sur le même modèle : même classe, aucune pastille « spéciale »
    const classes = [...container.querySelectorAll('[data-chip]')].map(c => c.className)
    expect(new Set(classes).size).toBe(1)
    // Aucun bouton de sélection ne subsiste
    const labels = [...container.querySelectorAll('button')].map(b => (b.textContent || '').trim())
    expect(labels.some(t => t.includes('Centre du Nez'))).toBe(false)
    expect(labels.some(t => t.includes('Boîtes de mesure'))).toBe(false)
  })

  it('les boîtes se déplacent sans sélection : croix et coins toujours rendus', async () => {
    const { container, tap, chip } = await mount()
    await tap('[data-markerid="bridge"]', 200, 430)
    await tap('[data-markerid="left"]', 120, 150)
    await tap('[data-markerid="right"]', 280, 150)
    fireEvent.click(chip('boxOG'))
    // 1 boîte × (1 croix + 4 coins) — accessibles d'emblée, sans sélection
    await waitFor(() => expect(container.querySelectorAll('[data-box-handle]').length).toBe(5))
    // Le verrouillage génère la seconde boîte → 10 contrôles, aucun ajout de bouton
    fireEvent.click(chip('boxOG'))
    await waitFor(() => expect(container.querySelectorAll('[data-box-handle]').length).toBe(10))
  })

  it('un tap pose le premier repère manquant, dans l’ordre Pont → OD → OG', async () => {
    const { tap, marker, chip } = await mount()

    expect(marker('bridge')).toBeFalsy()
    await tap('[data-markerid="bridge"]', 200, 430)
    expect(marker('left')).toBeFalsy()
    expect(marker('right')).toBeFalsy()

    await tap('[data-markerid="left"]', 120, 150)
    expect(marker('right')).toBeFalsy()

    await tap('[data-markerid="right"]', 280, 150)

    // Les trois pastilles sont posées
    for (const k of ['bridge', 'left', 'right']) {
      expect(chip(k).getAttribute('data-locked')).toBe('0')
      expect(chip(k).textContent).toContain('✓')
    }
  })

  it('tout posé → un tap à côté ne change plus rien', async () => {
    const { stage, tap, marker } = await mount()
    await tap('[data-markerid="bridge"]', 200, 430)
    await tap('[data-markerid="left"]', 120, 150)
    await tap('[data-markerid="right"]', 280, 150)

    const before = marker('left').parentElement.style.left
    fireEvent.pointerDown(stage, { clientX: 340, clientY: 480 })
    fireEvent.pointerDown(stage, { clientX: 60, clientY: 100 })
    expect(marker('left').parentElement.style.left).toBe(before)
  })

  it('la pastille sert de verrou : 🔒 puis déverrouillage', async () => {
    const { tap, chip } = await mount()
    await tap('[data-markerid="bridge"]', 200, 430)

    expect(chip('bridge').getAttribute('data-locked')).toBe('0')
    fireEvent.click(chip('bridge'))
    await waitFor(() => expect(chip('bridge').getAttribute('data-locked')).toBe('1'))
    expect(chip('bridge').textContent).toContain('🔒')

    fireEvent.click(chip('bridge'))
    await waitFor(() => expect(chip('bridge').getAttribute('data-locked')).toBe('0'))
  })

  it('un repère verrouillé n’est pas attrapable au drag', async () => {
    const { tap, chip, marker } = await mount()
    await tap('[data-markerid="bridge"]', 200, 430)
    const before = marker('bridge').parentElement.style.left

    fireEvent.click(chip('bridge'))
    await waitFor(() => expect(chip('bridge').getAttribute('data-locked')).toBe('1'))

    fireEvent.pointerDown(marker('bridge'), { clientX: 200, clientY: 430 })
    fireEvent.pointerMove(window, { clientX: 260, clientY: 430 })
    expect(marker('bridge').parentElement.style.left).toBe(before)
  })

  it('une pastille sans repère est inerte', async () => {
    const { chip } = await mount()
    expect(chip('left').disabled).toBe(true)
    expect(chip('left').textContent).toContain('—')
  })

  it('taper Box OD crée la boîte ; le tap suivant la verrouille et génère le miroir', async () => {
    const { tap, chip } = await mount()
    await tap('[data-markerid="bridge"]', 200, 430)

    expect(chip('boxOG').textContent).toContain('+')          // absente → le tap crée
    fireEvent.click(chip('boxOG'))
    await waitFor(() => expect(chip('boxOG').textContent).toContain('✓'))

    fireEvent.click(chip('boxOG'))                            // posée → le tap verrouille
    await waitFor(() => expect(chip('boxOG').textContent).toContain('🔒'))
    await waitFor(() => expect(chip('boxOD').textContent).toContain('✓'))   // miroir
  })

  it('la pastille Box OD est inerte tant que le nez n’est pas posé', async () => {
    const { chip } = await mount()
    expect(chip('boxOG').disabled).toBe(true)
    expect(chip('boxOG').textContent).toContain('+')
  })

  it('verrouiller une boîte rend ses contrôles inertes (comme pour un repère)', async () => {
    const { container, tap, chip } = await mount()
    await tap('[data-markerid="bridge"]', 200, 430)
    fireEvent.click(chip('boxOG'))
    await waitFor(() => expect(chip('boxOG').textContent).toContain('✓'))

    const move = container.querySelector('[data-box-handle="move"]')
    expect(move.getAttribute('style')).not.toContain('pointer-events: none')

    fireEvent.click(chip('boxOG'))
    await waitFor(() => expect(chip('boxOG').getAttribute('data-locked')).toBe('1'))
    expect(container.querySelector('[data-box-handle="move"]').getAttribute('style')).toContain('pointer-events: none')
  })

  it('Réinitialiser remet tout à l’état initial et laisse les repères reposables', async () => {
    const { container, tap, chip } = await mount()
    await tap('[data-markerid="bridge"]', 200, 430)
    await tap('[data-markerid="left"]', 120, 150)
    await tap('[data-markerid="right"]', 280, 150)
    fireEvent.click(chip('boxOG'))
    await waitFor(() => expect(chip('boxOG').textContent).toContain('✓'))
    fireEvent.click(chip('left'))                                    // on verrouille OD
    await waitFor(() => expect(chip('left').getAttribute('data-locked')).toBe('1'))

    fireEvent.click(container.querySelector('button[data-tool="reset"]'))

    // Sans référence connue (détection indisponible), tout est remis à zéro
    await waitFor(() => expect(chip('left').textContent).toContain('—'))
    expect(chip('bridge').textContent).toContain('—')
    expect(chip('right').textContent).toContain('—')
    expect(chip('boxOG').textContent).toContain('+')
    expect(chip('left').getAttribute('data-locked')).toBe('0')       // verrous levés

    // LE point du défaut : un repère effacé doit pouvoir être reposé
    await tap('[data-markerid="bridge"]', 200, 430)
    expect(chip('bridge').textContent).toContain('✓')
  })

  it('avec des coordonnées de référence, Réinitialiser y ramène les repères', async () => {
    const utils = render(
      <PupilMarker imageUrl="blob:fake" calibration={{ scalePxToMm: 0.25 }}
        initialLeftEye={{ x: 400, y: 500 }} initialRightEye={{ x: 600, y: 500 }}
        initialBridge={{ x: 500, y: 760 }}
        onConfirm={() => {}} onBack={() => {}} />)
    const { container } = utils
    await waitFor(() => expect(container.querySelector('[data-markerid="left"]')).toBeTruthy())
    const pos = () => container.querySelector('[data-markerid="left"]').parentElement.style.left

    const ref = pos()
    // On déplace OD au doigt
    fireEvent.pointerDown(container.querySelector('[data-markerid="left"]'), { clientX: 120, clientY: 150 })
    fireEvent.pointerMove(window, { clientX: 200, clientY: 150 })
    await waitFor(() => expect(pos()).not.toBe(ref))

    fireEvent.click(container.querySelector('button[data-tool="reset"]'))
    await waitFor(() => expect(pos()).toBe(ref))                     // retour à la référence
  })

  it('pointage assisté : activé d’office quand la détection échoue, et la pose a lieu au relâchement', async () => {
    const { container, chip } = await mount()
    const stage = container.querySelector('#pupil-image-container')
    await waitFor(() => expect(container.querySelector('button[data-tool="assist"]').dataset.assist).toBe('1'))

    fireEvent.pointerDown(stage, { clientX: 200, clientY: 430 })
    expect(container.querySelector('[data-loupe]')).toBeTruthy()      // on VISE
    expect(stage.textContent || '').toBeDefined()
    expect(chip('bridge').textContent).toContain('—')                // rien n’est posé

    fireEvent.pointerMove(stage, { clientX: 240, clientY: 400 })
    const l1 = container.querySelector('[data-loupe]').style.left
    fireEvent.pointerMove(stage, { clientX: 180, clientY: 460 })
    expect(container.querySelector('[data-loupe]').style.left).not.toBe(l1)   // la loupe suit le doigt

    fireEvent.pointerUp(stage, { clientX: 180, clientY: 460 })
    await waitFor(() => expect(chip('bridge').textContent).toContain('✓'))
    expect(container.querySelector('[data-loupe]')).toBeNull()       // visée refermée
  })

  it('pointage assisté : le bouton permet de reprendre la pose directe', async () => {
    const { container, chip } = await mount()
    const stage = container.querySelector('#pupil-image-container')
    const bouton = container.querySelector('button[data-tool="assist"]')
    await waitFor(() => expect(bouton.dataset.assist).toBe('1'))

    fireEvent.click(bouton)                                          // on le désactive
    await waitFor(() => expect(bouton.dataset.assist).toBe('0'))

    fireEvent.pointerDown(stage, { clientX: 200, clientY: 430 })
    await waitFor(() => expect(chip('bridge').textContent).toContain('✓'))   // pose immédiate
    expect(container.querySelector('[data-loupe]')).toBeNull()
  })

  it('tout posé, le pointage assisté déplace le repère le plus proche', async () => {
    const { container, chip, tap } = await mount()
    await tap('[data-markerid="bridge"]', 200, 430)
    await tap('[data-markerid="left"]', 120, 150)
    await tap('[data-markerid="right"]', 280, 150)
    await waitFor(() => expect(chip('left').textContent).toContain('✓'))

    const stage = container.querySelector('#pupil-image-container')
    const avant = container.querySelector('[data-markerid="left"]').parentElement.style.left

    // On vise près du repère OD, on glisse, puis on relâche ailleurs → il suit
    fireEvent.pointerDown(stage, { clientX: 122, clientY: 152 })
    expect(container.querySelector('[data-loupe]')).toBeTruthy()
    fireEvent.pointerMove(stage, { clientX: 180, clientY: 200 })
    fireEvent.pointerUp(stage, { clientX: 180, clientY: 200 })
    await waitFor(() => expect(
      container.querySelector('[data-markerid="left"]').parentElement.style.left).not.toBe(avant))
  })

  it('un repère verrouillé n’est pas déplacé par le pointage assisté', async () => {
    const { container, chip, tap } = await mount()
    await tap('[data-markerid="bridge"]', 200, 430)
    await tap('[data-markerid="left"]', 120, 150)
    await tap('[data-markerid="right"]', 280, 150)
    fireEvent.click(chip('left'))                                   // on verrouille OD
    await waitFor(() => expect(chip('left').getAttribute('data-locked')).toBe('1'))

    const stage = container.querySelector('#pupil-image-container')
    const avant = container.querySelector('[data-markerid="left"]').parentElement.style.left
    fireEvent.pointerDown(stage, { clientX: 122, clientY: 152 })
    fireEvent.pointerMove(stage, { clientX: 200, clientY: 240 })
    fireEvent.pointerUp(stage, { clientX: 200, clientY: 240 })
    await new Promise((r) => setTimeout(r, 60))
    expect(container.querySelector('[data-markerid="left"]').parentElement.style.left).toBe(avant)
  })
})
