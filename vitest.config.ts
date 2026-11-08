import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The network guard first: nothing a test file imports may reach a real host.
    setupFiles: ['tests/setup/network-guard.ts', 'tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/types.ts'],
      reporter: ['text', 'html'],
    },
  },
})
