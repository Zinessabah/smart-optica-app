import { describe, it, expect } from 'vitest'
import { filterHistoryItems } from './historyFilter'

const items = [
  { id: 1, patient_name: 'Amélie Dupont', frame_ref: 'Ray-Ban RB5154', pd: 62.5, pont: 18, notes: 'progressif' },
  { id: 2, patient_name: 'Karim Benali', frame_ref: 'Lindberg 6500', pd: 64, pont: 16, notes: '' },
  { id: 3, patient_name: null, frame_ref: null, pd: 58, pont: 14 },
]

describe('filterHistoryItems', () => {
  it('retourne la liste intacte si la recherche est vide', () => {
    expect(filterHistoryItems(items, '')).toEqual(items)
    expect(filterHistoryItems(items, '   ')).toEqual(items)
  })

  it('filtre par nom de patient sans tenir compte des accents', () => {
    const found = filterHistoryItems(items, 'amelie')
    expect(found.map((i) => i.id)).toEqual([1])
  })

  it('filtre par référence de monture', () => {
    const found = filterHistoryItems(items, 'lindberg')
    expect(found.map((i) => i.id)).toEqual([2])
  })

  it('exige tous les mots (ET)', () => {
    expect(filterHistoryItems(items, 'amelie rb5154').map((i) => i.id)).toEqual([1])
    expect(filterHistoryItems(items, 'amelie lindberg')).toEqual([])
  })

  it('cherche aussi dans la DP affichée et les notes', () => {
    expect(filterHistoryItems(items, '62.5').map((i) => i.id)).toEqual([1])
    expect(filterHistoryItems(items, 'progressif').map((i) => i.id)).toEqual([1])
  })

  it('ignore une entrée nulle et une liste invalide', () => {
    expect(filterHistoryItems(null, 'a')).toEqual([])
    expect(filterHistoryItems([null, items[1]], 'karim').map((i) => i.id)).toEqual([2])
  })
})
