
const { App } = require('koishi')
const { Context: SatoriContext } = require('@satorijs/satori')
const { Context: CoreContext } = require('@satorijs/core')

const app = new App({ port: 5140 })

async function main() {
  await app.start()
  
  console.log('1. SatoriContext.Session:', typeof SatoriContext.Session)
  console.log('2. CoreContext.Session:', typeof CoreContext.Session)
  console.log('3. app.constructor.Session:', typeof app.constructor.Session)
  console.log('4. app.ctx.constructor.Session:', typeof app.ctx.constructor.Session)
  
  // Is app.ctx.constructor === SatoriContext?
  console.log('5. app.ctx.constructor === SatoriContext:', app.ctx.constructor === SatoriContext)
  
  // Check if SatoriContext is in the prototype chain
  let proto = app.ctx.constructor
  while (proto) {
    if (proto === SatoriContext) {
      console.log('6. Found SatoriContext in chain!')
    }
    proto = Object.getPrototypeOf(proto)
  }
  
  // Check the exact import used by onebot adapter
  const adapter = require('@satorijs/adapter-onebot')
  console.log('7. Adapter default:', typeof adapter.default)
  
  process.exit(0)
}
main().catch(err => { console.error(err); process.exit(1) })
