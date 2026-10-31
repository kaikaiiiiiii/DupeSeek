import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 引擎测试依赖 Windows 路径语义（path.dirname 与反斜杠分隔符），
    // 仅在 Windows 上运行；CI 使用 windows-latest runner（见 test.yml）
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000
  }
})
