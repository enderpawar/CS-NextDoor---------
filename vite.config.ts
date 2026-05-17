import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => ({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/main.tsx'],
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Electron renderer는 file:// 프로토콜 → 상대 경로 필수
  base: mode === 'electron' ? './' : '/',
  build: {
    outDir: mode === 'electron' ? 'dist/renderer' : 'dist/pwa',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  define: {
    // 런타임 모드 구분용 환경변수
    __APP_MODE__: JSON.stringify(mode),
  },
}));
