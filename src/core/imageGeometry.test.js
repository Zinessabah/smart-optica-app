import { describe, it, expect } from 'vitest'
import { computeContainedImageRect, screenPointToImage } from './imageGeometry'

describe('imageGeometry', () => {
  it('calcule les bandes verticales pour une image paysage dans un cadre portrait', () => {
    const rect = computeContainedImageRect(300, 400, 400, 200)

    expect(rect).toEqual({ left: 0, top: 125, width: 300, height: 150 })
  })

  it('convertit un point du contenu affiché vers les coordonnées naturelles', () => {
    const display = { left: 0, top: 125, width: 300, height: 150 }
    const point = screenPointToImage(
      160,
      300,
      { left: 10, top: 100 },
      display,
      { width: 400, height: 200 },
    )

    expect(point.x).toBeCloseTo(200, 6)
    expect(point.y).toBeCloseTo(100, 6)
  })

  it('rejette un clic dans une bande de letterboxing', () => {
    const display = { left: 0, top: 125, width: 300, height: 150 }
    const point = screenPointToImage(
      160,
      150,
      { left: 10, top: 100 },
      display,
      { width: 400, height: 200 },
    )

    expect(point).toBeNull()
  })
})
