import { describe, it, expect } from 'vitest'
import { selectPdfPhoto, buildPdfPhotoList } from './pdfPhotos'

describe('selectPdfPhoto', () => {
  it('priorise l\'image annotée quand elle est disponible', () => {
    expect(selectPdfPhoto('data:image/png;base64,ANNOTEE', 'data:image/jpeg;base64,BRUTE')).toBe('data:image/png;base64,ANNOTEE')
  })

  it('retombe sur l\'image brute si l\'annotée est absente', () => {
    expect(selectPdfPhoto(undefined, 'data:image/jpeg;base64,BRUTE')).toBe('data:image/jpeg;base64,BRUTE')
    expect(selectPdfPhoto(null, 'data:image/jpeg;base64,BRUTE')).toBe('data:image/jpeg;base64,BRUTE')
  })

  it('retourne null si aucune image', () => {
    expect(selectPdfPhoto(undefined, null)).toBeNull()
    expect(selectPdfPhoto(null, '')).toBeNull()
  })
})

describe('buildPdfPhotoList', () => {
  it('liste face+profil, face annotée prioritaire', () => {
    const list = buildPdfPhotoList({
      annotatedImageUrl: 'data:image/png;base64,ANNOTEE',
      imageUrl: 'data:image/jpeg;base64,BRUTE',
      profileImageUrl: 'data:image/jpeg;base64,PROFIL',
    })
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ label: 'Face' })
    expect(list[0].url).toBe('data:image/png;base64,ANNOTEE')
    expect(list[1].label).toBe('Profil D')
  })

  it('sans image annotée, utilise la photo brute pour la face', () => {
    const list = buildPdfPhotoList({
      imageUrl: 'data:image/jpeg;base64,BRUTE',
      profileImageUrl: null,
    })
    expect(list).toHaveLength(1)
    expect(list[0].url).toBe('data:image/jpeg;base64,BRUTE')
  })
})
