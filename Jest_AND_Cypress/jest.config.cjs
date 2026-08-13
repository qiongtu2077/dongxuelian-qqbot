const path = require('path')

module.exports = {
  rootDir: __dirname,
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  moduleFileExtensions: ['js', 'json', 'ts', 'vue'],
  transform: {
    '^.+\\.vue$': '@vue/vue3-jest',
    '^.+\\.[jt]s$': 'babel-jest',
  },
  moduleNameMapper: {
    '^@dashboard/(.*)$': path.join(__dirname, '..', 'packages', 'koishi-plugin-dashboard', 'frontend', 'src', '$1'),
    '^vue$': path.join(__dirname, 'node_modules', 'vue'),
  },
  clearMocks: true,
  restoreMocks: true,
}
