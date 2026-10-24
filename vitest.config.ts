import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // 客户端源码使用 `@/` 别名（见 packages/client/vite.config.ts），测试里同样需要
      '@': fileURLToPath(new URL('./packages/client/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // .tsx 覆盖 React 组件测试（文件内用 // @vitest-environment jsdom 指定 DOM 环境）
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
  },
})
