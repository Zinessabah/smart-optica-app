import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Config pour les tests d'intégration React (jsdom).
// Utilisée par `npm run test:integration`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/__tests__/**/*.test.{js,jsx,ts,tsx}'],
    globals: true,
  },
})
