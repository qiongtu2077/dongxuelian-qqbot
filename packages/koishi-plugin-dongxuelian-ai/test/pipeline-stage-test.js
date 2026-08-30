'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const AI_ROOT = path.resolve(__dirname, '..')

// Returns the inclusive source-line count of one named function declaration.
function getFunctionLineCount(relativePath, functionName) {
  const filePath = path.join(AI_ROOT, relativePath)
  const sourceText = fs.readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let target = null
  sourceFile.forEachChild(node => {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === functionName) target = node
  })
  assert(target, `${relativePath} must declare ${functionName}`)
  const start = sourceFile.getLineAndCharacterOfPosition(target.getStart(sourceFile)).line
  const end = sourceFile.getLineAndCharacterOfPosition(target.end).line
  return end - start + 1
}

// Verifies that the confirmed chat and command stages remain orchestration-sized.
function assertFunctionBudgets() {
  assert(getFunctionLineCount('src/chat.ts', 'chat') <= 400, 'chat must stay within its 400-line orchestration gate')
  assert(getFunctionLineCount('src/chat.ts', 'prepareChatIdentityStage') <= 140)
  assert(getFunctionLineCount('src/chat.ts', 'executeChatModelStage') <= 190)
  assert(getFunctionLineCount('src/handler.ts', 'handleCommand') <= 140)
  assert(getFunctionLineCount('src/handler.ts', 'handleOperationalCommandDomain') <= 190)
  assert(getFunctionLineCount('src/handler.ts', 'handleConversationCommandDomain') <= 240)
}

// Verifies that each extracted stage has a direct test hook in the compiled contract.
function assertStageExports() {
  const chat = require('../lib/chat')
  const handler = require('../lib/handler')
  assert.strictEqual(typeof chat._test.prepareChatIdentityStage, 'function')
  assert.strictEqual(typeof chat._test.executeChatModelStage, 'function')
  assert.strictEqual(typeof handler._test.handleOperationalCommandDomain, 'function')
  assert.strictEqual(typeof handler._test.handleConversationCommandDomain, 'function')
}

// Runs the AI pipeline structure and testability guard.
function main() {
  assertFunctionBudgets()
  assertStageExports()
  console.log('AI pipeline stage tests passed')
}

main()
