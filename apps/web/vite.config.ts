import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The browser only talks to /bo/v1. In development Vite forwards it to the API so the session
// cookie is same-origin; on Vercel it is a rewrite to the API.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, host: '127.0.0.1', proxy: { '/bo': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', changeOrigin: false } } },
  build: { sourcemap: true, target: 'es2023' },
})
