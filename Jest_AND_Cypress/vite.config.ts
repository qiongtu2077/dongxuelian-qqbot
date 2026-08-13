import path from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  root: path.resolve(__dirname, '../packages/koishi-plugin-dashboard/frontend'),
  plugins: [vue()],
  base: '/dashboard/',
  server: {
    host: '127.0.0.1',
    port: 41731,
    strictPort: true,
  },
})
