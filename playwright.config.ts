import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false, // each test launches its own persistent extension context; keep them from fighting over ports/state
  retries: 0,
  reporter: [['list']],
  webServer: {
    command: 'npx serve tests/harness/fake-meet -l 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
