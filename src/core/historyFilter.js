/**
 * Filtre local de l'historique des mesures — fonctions pures (testables).
 * Cherche dans le nom patient, la monture, les notes et les valeurs affichées.
 */

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

function haystack(item) {
  if (!item || typeof item !== 'object') return ''
  const parts = [
    item.patient_name,
    item.frame_ref,
    item.notes,
    item.pd != null ? `${item.pd} mm` : '',
    item.pont != null ? `pont ${item.pont}` : '',
  ]
  return normalize(parts.filter(Boolean).join(' '))
}

/**
 * @param {Array<Record<string, unknown>>} items
 * @param {string} query
 * @returns {Array<Record<string, unknown>>}
 */
export function filterHistoryItems(items, query) {
  if (!Array.isArray(items)) return []
  const tokens = normalize(query).split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return items
  return items.filter((item) => {
    const text = haystack(item)
    return tokens.every((token) => text.includes(token))
  })
}
