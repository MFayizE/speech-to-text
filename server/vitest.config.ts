import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // API and WebSocket suites share one Postgres test database.
    fileParallelism: false,
  },
});
