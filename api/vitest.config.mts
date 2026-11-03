import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Child processes, not worker threads, and one file at a time: the opt-in
    // MySQL suite shares a single database, and a hung test should be killable.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 30_000,
  },
});
