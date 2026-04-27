
const fs = require("fs")
const https = require("https")

// Read the local image
const buf = fs.readFileSync("/root/.config/QQ/nt_qq_1b8a050b0662d6f195a7683c25ec7195/nt_data/Pic/2026-04/Ori/9e53c8fbe144b477a9d9805fee02ba7c.png")
const b64 = buf.toString("base64")
const dataUrl = "data:image/png;base64," + b64

const body = JSON.stringify({
  model: "qwen3.6-plus",
  messages: [
    { role: "user", content: [
      { type: "text", text: "describe this image in one sentence" },
      { type: "image_url", image_url: { url: dataUrl } }
    ]}
  ],
  max_tokens: 100
})

const t0 = Date.now()
const req = https.request({
  hostname: "opencode.ai",
  path: "/zen/go/v1/chat/completions",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer sk-FVO2GvHhW9JIsbGXnfWtnVkyF2eFeR5VhSlKzArvdyRYxggfIUjcSOMWk66RnmTq",
    "Content-Length": Buffer.byteLength(body)
  }
}, (res) => {
  let d = ""
  res.on("data", c => d += c)
  res.on("end", () => {
    const elapsed = Date.now() - t0
    try {
      const r = JSON.parse(d)
      const c = r.choices?.[0]?.message?.content || "(empty)"
      console.log("TIME:", elapsed, "ms")
      console.log("RESULT:", c.slice(0, 200))
    } catch {
      console.log("PARSE ERROR:", d.slice(0, 200))
    }
  })
})
req.write(body)
req.end()
