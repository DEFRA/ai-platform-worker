import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    clearMocks: true,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js'],
      // Every line, function, branch and statement of the worker is new code
      // (plan 8): 95 across the repository.
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95
      },
      // Contract suites, not application code: they run (and so are covered)
      // through the test files of the adapters that call them.
      exclude: [...configDefaults.exclude, 'coverage', 'src/**/*-contract.js']
    },
    setupFiles: ['.vite/setup-files.js']
  }
})
