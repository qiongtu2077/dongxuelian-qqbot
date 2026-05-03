const path = require('path')
const { withScenario } = require('./_setup')
const { AI_ROOT } = require('../fake/file')

async function run(t) {
  t.section('scenario: vision session helpers')

  await withScenario({}, async ({ makeSession }) => {
    const vision = require(path.join(AI_ROOT, 'lib', 'vision.js'))
    const session = makeSession({
      content: '[CQ:image,file=current.jpg,url=http://example.test/current.jpg]',
      event: { sender: { role: 'member' }, message: [{ type: 'image', data: { file: 'current.jpg', url: 'http://example.test/current.jpg' } }] },
    })
    const marked = vision.prepareVisionRequest(session, { hasVisual: true, hasFile: true, hasEmbed: false }, {
      content: session.content,
      allowCurrentMessage: true,
      includeQuote: false,
    })
    const payload = vision.getVisionPayload(session)
    t.check('scenario vision current image marks session', marked && vision.isVisionSession(session), JSON.stringify(payload))
    t.check('scenario vision current image captures file', payload.file === 'current.jpg', JSON.stringify(payload))
    t.check('scenario vision clear removes current image marker', (vision.clearVisionSession(session), !vision.isVisionSession(session)), JSON.stringify(vision.getVisionPayload(session)))
  })

  await withScenario({}, async ({ makeSession }) => {
    const vision = require(path.join(AI_ROOT, 'lib', 'vision.js'))
    const session = makeSession({
      content: '这张图是什么',
      quote: {
        message: [{ type: 'image', data: { file: 'quoted.jpg', url: 'http://example.test/quoted.jpg' } }],
      },
    })
    const marked = vision.prepareVisionRequest(session, { hasVisual: false, hasFile: false, hasEmbed: false }, {
      content: session.content,
      allowCurrentMessage: false,
      includeQuote: true,
    })
    const payload = vision.getVisionPayload(session)
    t.check('scenario vision quoted image marks session', marked && vision.isVisionSession(session), JSON.stringify(payload))
    t.check('scenario vision quoted image captures file', payload.file === 'quoted.jpg', JSON.stringify(payload))
  })

  await withScenario({}, async ({ makeSession }) => {
    const vision = require(path.join(AI_ROOT, 'lib', 'vision.js'))
    const session = makeSession({ content: 'plain text only' })
    const marked = vision.prepareVisionRequest(session, { hasVisual: false, hasFile: false, hasEmbed: false }, {
      content: session.content,
      allowCurrentMessage: true,
      includeQuote: true,
    })
    t.check('scenario vision plain text does not mark session', !marked && !vision.isVisionSession(session), JSON.stringify(vision.getVisionPayload(session)))
  })
}

module.exports = { run }
