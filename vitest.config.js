import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Config de test par défaut (unitaires, node). Les tests d'intégration jsdom
// vivent dans src/__tests__/ et sont lancés via `npm run test:integration`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/core/**/*.test.{js,jsx,ts,tsx}'],
    exclude: ['src/__tests__/**', 'node_modules/**', 'dist/**'],
    globals: true,
  },
})
