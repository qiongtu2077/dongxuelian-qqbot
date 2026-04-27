
const path = require('path')

// Check which core the koishijs/core resolves to
const koishiCorePath = require.resolve('@koishijs/core')
console.log('koishijs/core:', koishiCorePath)

// Check the imports inside @koishijs/core
const koishiCoreDir = path.dirname(koishiCorePath)
console.log('koishijs/core dir:', koishiCoreDir)

// Which @satorijs/core does @koishijs/core use?
try {
  const satoriCorePath = require.resolve('@satorijs/core', { paths: [koishiCoreDir] })
  console.log('koishijs/core -> @satorijs/core:', satoriCorePath)
  console.log('version:', require(satoriCorePath + '/package.json').version)
} catch(e) {
  console.log('Error resolving:', e.message)
}

// Which @satorijs/core does koishi use?
const koishiPath = require.resolve('koishi')
console.log('\nkoishi:', koishiPath)
const koishiDir = path.dirname(koishiPath)
try {
  const satoriCorePath = require.resolve('@satorijs/core', { paths: [koishiDir] })
  console.log('koishi -> @satorijs/core:', satoriCorePath)
  console.log('version:', require(satoriCorePath + '/package.json').version)
} catch(e) {
  console.log('Error resolving:', e.message)
}

// Check the App's inheritance
const { App } = require('koishi')
const app = new App({ port: 5140 })

console.log('\nApp prototype:')
let proto = app
let level = 0
while (proto && level < 10) {
  const name = proto.constructor ? proto.constructor.name : 'null'
  const mod = modulePath(proto.constructor)
  console.log('  '.repeat(level) + name + (mod ? ' [' + mod + ']' : ''))
  proto = Object.getPrototypeOf(proto)
  level++
}

function modulePath(cls) {
  if (!cls) return ''
  const fn = cls.toString().split('\n')[0]
  // try to find where it was defined
  return ''
}
