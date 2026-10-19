import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export default defineConfig({
  plugins: [react(), {
    name: 'cad-runtime-notices',
    generateBundle() {
      for (const name of ['license.occt.txt', 'license.occt-import-js.txt']) {
        this.emitFile({ type: 'asset', name, source: readFileSync(require.resolve(`occt-import-js/dist/${name}`)) })
      }
    },
  }],
  publicDir: '../../assets/brand',
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 43111,
    proxy: { '/api': 'http://127.0.0.1:43110' },
  },
})
