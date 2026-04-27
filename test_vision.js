
const ws = new (require("ws"))("ws://127.0.0.1:8080/onebot/v11/ws")
ws.on("open", () => {
  ws.send(JSON.stringify({ action: "get_image", params: { file: "9E53C8FBE144B477A9D9805FEE02BA7C.png" }, echo: "gi" }))
})
ws.on("message", (d) => {
  const m = JSON.parse(d.toString())
  if (m.echo === "gi") {
    if (m.data && m.data.file) {
      console.log("PATH:", m.data.file)
      const fs = require("fs")
      const buf = fs.readFileSync(m.data.file)
      const b64 = buf.toString("base64")
      console.log("SIZE:", buf.length)
      console.log("B64_LEN:", b64.length)
      console.log("B64_OK:", b64.length > 0 ? "YES" : "NO")
    } else {
      console.log("FAIL:", JSON.stringify(m))
    }
    ws.close()
    process.exit(0)
  }
})
setTimeout(() => { console.log("TIMEOUT"); process.exit(1) }, 5000)
