import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// El navegador solo habla con /bo/v1 (docs/08 §4). En desarrollo Vite lo reenvía a la API para que
// la cookie de sesión sea del mismo origen; en Vercel es un rewrite hacia la API (docs/deploy, fase 8).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, host: '127.0.0.1', proxy: { '/bo': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', changeOrigin: false } } },
  build: { sourcemap: true, target: 'es2023' },
})
