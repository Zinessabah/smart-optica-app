import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Certificat local de confiance (mkcert) — couvre localhost, 127.0.0.1 et l'IP Tailscale iPad.
// Permet à Safari iOS d'accéder sans alerte de certificat une fois la CA mkcert installée.
const certPath = path.resolve(__dirname, 'certs/localhost.pem')
const keyPath = path.resolve(__dirname, 'certs/localhost-key.pem')
const hasCert = fs.existsSync(certPath) && fs.existsSync(keyPath)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Alias '@' → src, utilisé par le barrel core/index.js (import { … } from '@/core')
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    https: hasCert ? {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    } : undefined,
    proxy: {
      '/api': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
    },
  },
})
