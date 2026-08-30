'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

// Reads one repository file as UTF-8 text for release-entrypoint assertions.
function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

// Verifies that one retired remote-deployment script cannot perform network work.
function assertRetiredScript(relativePath) {
  const source = read(relativePath)
  assert.match(source, /\[已停用\]/, `${relativePath} must explain that it is retired`)
  assert.match(source, /Dashboard.*部署/, `${relativePath} must direct users to Dashboard deployment`)
  assert.match(source, /^exit \/b 2\s*$/m, `${relativePath} must fail closed`)
  assert.doesNotMatch(source, /^\s*(?:scp|ssh)\b/im, `${relativePath} must not transfer files or execute remote commands`)
  assert.doesNotMatch(source, /DEPLOY_SERVER|DEPLOY_APP_DIR|restart\.sh/i, `${relativePath} must not retain a remote target or restart path`)
}

// Verifies that repository documentation exposes only the immutable remote release path.
function assertDocumentationContract() {
  const readme = read('readme2.md')
  const lessons = read('教训总结.md')
  const deploymentGuide = read('部署教程.txt')
  const documentation = [readme, lessons, deploymentGuide].join('\n')

  assert.match(readme, /唯一远程生产更新入口/)
  assert.match(readme, /deploy\.bat[\s\S]{0,160}不用于远程生产发布/)
  assert.match(deploymentGuide, /唯一方式：Dashboard 安全不可变发布/)
  assert.match(deploymentGuide, /发布文件清单与内容哈希校验/)
  assert.match(deploymentGuide, /失败自动回滚/)
  assert.doesNotMatch(documentation, /^\s*scripts\\deploy-(?:frontend|and-restart)\.bat(?:\s|$)/m)
  assert.doesNotMatch(documentation, /^\s*scp\s+packages\/koishi-plugin-/m)
  assert.doesNotMatch(documentation, /scripts\/.*按插件更新（推荐）/)
}

// Runs the static release-entrypoint guard.
function main() {
  assertRetiredScript('scripts/deploy-frontend.bat')
  assertRetiredScript('scripts/deploy-and-restart.bat')
  assertDocumentationContract()
  console.log('remote release entrypoint tests passed')
}

main()
