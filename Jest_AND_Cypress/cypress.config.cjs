const { defineConfig } = require('cypress')

module.exports = defineConfig({
  allowCypressEnv: false,
  video: false,
  screenshotOnRunFailure: true,
  e2e: {
    baseUrl: 'http://127.0.0.1:41731/dashboard/',
    specPattern: 'cypress/e2e/**/*.cy.js',
    supportFile: false,
  },
})
