
const { App } = require('koishi')
const app = new App({ port: 5140 })

async function main() {
  await app.start()
  // Check constructor chain for Session
  let proto = app.constructor
  const chain = []
  while (proto) {
    chain.push(proto.name + ' Session=' + typeof proto.Session)
    proto = Object.getPrototypeOf(proto)
  }
  console.log(chain.join(' -> '))
  
  // Also check what koishi's App inherits from
  console.log('App prototype chain:')
  let p = app
  while (p) {
    console.log('  ', p.constructor ? p.constructor.name : 'null')
    p = Object.getPrototypeOf(p)
  }
  
  process.exit(0)
}
main().catch(err => { console.error(err); process.exit(1) })
