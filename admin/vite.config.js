import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Certificat local de confiance (mkcert) — couvre localhost, 127.0.0.1 et l'IP Tailscale.
const certPath = path.resolve(__dirname, '../certs/localhost.pem')
const keyPath = path.resolve(__dirname, '../certs/localhost-key.pem')
const hasCert = fs.existsSync(certPath) && fs.existsSync(keyPath)

export default defineConfig({
  root: path.resolve(__dirname, '.'),
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    https: hasCert ? {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    } : undefined,
    proxy: {
      '/api': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
    },
  },
  preview: { host: '0.0.0.0', port: 5174 },
  build: { outDir: path.resolve(__dirname, '../admin/dist') }
})
