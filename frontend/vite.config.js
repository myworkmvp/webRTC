import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'

// Reuse the backend's self-signed cert so the dev site is HTTPS (needed for camera on LAN IPs).
const dir = '../backend/certs'
const https = fs.existsSync(`${dir}/cert.pem`)
  ? { key: fs.readFileSync(`${dir}/key.pem`), cert: fs.readFileSync(`${dir}/cert.pem`) }
  : undefined

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, port: 5173, https,
    proxy: {
      '/api': { target: 'https://localhost:8443', secure: false },
      '/ws': { target: 'https://localhost:8443', ws: true, secure: false },
    },
  },
})
