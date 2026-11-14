import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // Read VITE_* settings from the project's root .env. Only VITE_* keys reach the browser.
  envDir: '..',
  server: {
    proxy: { '/api': 'http://localhost:8000' },
  },
})
