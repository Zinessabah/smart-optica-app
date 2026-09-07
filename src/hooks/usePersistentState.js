/**
 * Hook de persistance — enrobe useState avec sauvegarde localStorage.
 * La lecture initiale restaure la valeur si elle existe ; sinon valeur par défaut.
 * Les écritures sont tolérantes (si quota dépassé, on continue sans crash).
 */
import { useState, useEffect, useCallback } from 'react'

export function usePersistentState(key, initialValue) {
  const storageKey = `smart-optica:${key}`

  const [value, setValue] = useState(() => {
    // Lecture paresseuse : seulement au premier rendu, dans un navigateur réel.
    if (typeof window === 'undefined' || !window.localStorage) return initialValue
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw !== null) return JSON.parse(raw)
    } catch {
      /* données corrompues → on repart de la valeur par défaut */
    }
    return initialValue
  })

  // Persiste à chaque changement.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(value))
    } catch {
      /* quota dépassé → silencieux (pas de crash) */
    }
  }, [storageKey, value])

  // Setter qui fonctionne aussi avec une fonction updater (comme setState).
  const set = useCallback((updater) => {
    setValue((prev) => (typeof updater === 'function' ? updater(prev) : updater))
  }, [])

  // Permet de purger la clé (reprise → reset).
  const clear = useCallback(() => {
    if (typeof window === 'undefined' || !window.localStorage) return
    try {
      window.localStorage.removeItem(storageKey)
    } catch {
      /* ignore */
    }
    setValue(initialValue)
  }, [storageKey, initialValue])

  return [value, set, clear]
}
