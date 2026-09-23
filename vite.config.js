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

// Réglages COMMUNS au serveur de dev (`npm run dev`, HMR) et au serveur de preview
// (`npm run preview`, qui sert le build figé de `dist/`).
// ⚠️ Le preview DOIT porter le même HTTPS que le dev : une app installée servie en HTTP est
// refusée par Safari (iPad) et `getUserMedia` exige un contexte sécurisé — la caméra ne
// s'ouvrirait même pas. Sans certificat (`--dev` jamais lancé, `certs/` vide), on retombe
// sur HTTP plutôt que de planter au démarrage.
const sharedServer = {
  host: '0.0.0.0',
  https: hasCert ? {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  } : undefined,
  proxy: {
    '/api': 'http://localhost:8000',
    '/health': 'http://localhost:8000',
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Alias '@' → src, utilisé par le barrel core/index.js (import { … } from '@/core')
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: { ...sharedServer, port: 5173 },
  // Build figé servi sur le MÊME port que le dev (5173) : l'URL de l'iPad ne change pas
  // selon qu'on est en mode installé ou en développement.
  preview: { ...sharedServer, port: 5173 },
})
