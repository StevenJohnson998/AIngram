// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  use: {
    headless: true,
    baseURL: process.env.BASE_URL || 'http://172.18.0.22:3000',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
