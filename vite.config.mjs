import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const backend = `http://127.0.0.1:${process.env.PORT || 8899}`;
// 部署在子路径时构建：BASE_PATH=/hongguo npm run build（反向代理负责去掉前缀再转发）
const base = `${(process.env.BASE_PATH || '').replace(/\/+$/, '')}/`;

export default defineConfig({
  root: 'web',
  base,
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
