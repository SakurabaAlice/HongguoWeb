import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const backend = `http://127.0.0.1:${process.env.PORT || 8899}`;

export default defineConfig({
  root: 'web',
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: { '/api': backend, '/media': backend },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
