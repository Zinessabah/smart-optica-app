import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../App'

// jsdom localStorage
function makeStorage() {
  let store = {}
  return {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
    clear: () => { store = {} },
  }
}

// Mock réseaux (checkHealth, fetchMe) pour éviter les erreurs réseau
vi.mock('../services/api', () => ({
  analyzeImage: vi.fn(() => ({ face_detected: false })),
  checkHealth: vi.fn(() => Promise.resolve(true)),
}))
vi.mock('../services/auth', () => ({
  getToken: vi.fn(() => 'fake-token'),
  fetchMe: vi.fn(() => Promise.resolve({ id: '1', name: 'Test', email: 't@t.ma' })),
  clearSession: vi.fn(),
}))

describe('App — persistance de session (intégration)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'localStorage', { value: makeStorage(), writable: true })
  })

  it('rend l\'écran d\'accueil pour un utilisateur authentifié', async () => {
    render(<App />)
    await screen.findByText(/Prendre 2 photos/)
    expect(screen.getAllByText(/Smart Optica/).length).toBeGreaterThan(0)
  })

  it('restaure une session à l\'étape calibrate quand les prérequis sont là', async () => {
    // Prépare une session persistée
    window.localStorage.setItem('smart-optica:session:v1', JSON.stringify({
      step: 'calibrate',
      photoSource: 'upload',
      imageData: 'data:image/jpeg;base64,AAAA',
      profileImageUrl: null,
      calibration: null,
      measurements: null,
      faceData: { face_detected: true },
    }))
    render(<App />)
    await screen.findByText(/Recherche automatique|① Gauche|Calibrage/i)
  })
})
