// @ts-check
const { defineConfig } = require('@playwright/test');

// Allow overriding the chromium binary (Alpine apk install vs Playwright bundled glibc binary)
const useSystemChromium = !!process.env.PLAYWRIGHT_CHROMIUM_PATH;

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  use: {
    headless: true,
    baseURL: process.env.BASE_URL || 'http://172.18.0.22:3000',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        ...(useSystemChromium && {
          launchOptions: {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
          },
        }),
      },
    },
  ],
});
