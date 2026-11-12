import { defineConfig } from 'vite'
import { cp } from 'node:fs/promises'
import { resolve } from 'node:path'

export default defineConfig({
  base: './',
  publicDir: false,
  build: { target: 'es2022' },
  plugins: [{
    name: 'local-game-assets',
    async closeBundle() {
      await cp(resolve('assets'), resolve('dist/assets'), { recursive: true })
    },
  }],
})
