import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Toxics are global state on shared proxies and VaultChain's sim-clock is
  // global — resilience tests must never run concurrently (CLAUDE.md).
  workers: 1,
  fullyParallel: false,
  // A resilience invariant that only passes on retry is not passing.
  retries: 0,
  forbidOnly: !!process.env['CI'],
  // Generous per-test ceiling: individual operations carry their own explicit
  // budgets (AbortSignal.timeout); this only catches runaway tests.
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
});
