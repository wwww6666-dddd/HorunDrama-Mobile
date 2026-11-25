import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 新前端只认新核心（apps/core）。旧服务端 5878 冻结，不再对接。
const CORE = process.env.HORUN_CORE ?? 'http://127.0.0.1:5880';

/**
 * 手机端版本号只认 `apps/mobile-web/package.json`。
 * 早先这里读 `apps/desktop/package.json`，手机端工程里没有 desktop 目录，
 * 于是关于页一直显示 0.0.0。
 */
function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  server: {
    port: 5274,
    strictPort: false,
    proxy: {
      '/api': { target: CORE, changeOrigin: false },
      '/media': { target: CORE, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    // 生产包不需要 sourcemap：之前每次构建都残留 2.5MB/份的 .map，16 份约 39MB
    sourcemap: false,
    emptyOutDir: true,
  },
});
