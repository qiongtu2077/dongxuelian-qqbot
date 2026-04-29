const sharp = require('sharp')
const fs = require('fs')
const path = require('path')

async function main() {
const STICKER_DIR = path.join(__dirname, 'temp_stickers', 'stickers')
const OUT_DIR = path.join(__dirname, 'temp_stickers_compressed')
const MAX_DIM = 300
const JPEG_QUALITY = 65
const MAX_SIZE_KB = 18

fs.mkdirSync(OUT_DIR, { recursive: true })

const files = fs.readdirSync(STICKER_DIR)
let inTotal = 0, outTotal = 0, compressed = 0, skipped = 0

for (const file of files) {
  const src = path.join(STICKER_DIR, file)
  const stat = fs.statSync(src)
  if (!stat.isFile()) continue
  const ext = path.extname(file).toLowerCase()
  const sizeKB = stat.size / 1024
  inTotal += stat.size

  // GIF → .jpg (first frame)
  const isGif = ext === '.gif'
  const outFile = isGif ? path.basename(file, ext) + '.jpg' : file
  const outPath = path.join(OUT_DIR, outFile)

  if (sizeKB <= 12 && !isGif) {
    fs.copyFileSync(src, outPath)
    console.log(`  SKIP ${file} (${sizeKB.toFixed(1)}KB)`)
    skipped++; outTotal += stat.size
    continue
  }

  compressed++
  try {
    let img = sharp(src)
    const meta = await img.metadata()
    let w = meta.width, h = meta.height
    if (w > MAX_DIM || h > MAX_DIM) {
      if (w >= h) { w = MAX_DIM; h = undefined }
      else { h = MAX_DIM; w = undefined }
      img = sharp(src).resize(w, h, { fit: 'inside', withoutEnlargement: true })
    }
    let q = JPEG_QUALITY
    await img.jpeg({ quality: q, mozjpeg: true }).toFile(outPath)
    let sz = fs.statSync(outPath).size
    while (sz / 1024 > MAX_SIZE_KB && q > 15) {
      q -= 10
      const p = sharp(src).resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      await p.jpeg({ quality: q, mozjpeg: true }).toFile(outPath)
      sz = fs.statSync(outPath).size
    }
    outTotal += sz
    const tag = isGif ? 'GIF→JPG' : 'IMG'
    console.log(`  OK  ${file} → ${outFile}  ${tag}  ${sizeKB.toFixed(1)}KB → ${(sz/1024).toFixed(1)}KB`)
  } catch (err) {
    console.error(`  FAIL ${file}: ${err.message}`)
    sharp(src).jpeg({ quality: 40 }).toFile(outPath).catch(() => {})
  }
}

console.log(`\nDone. ${compressed} compressed, ${skipped} skipped.`)
console.log(`Size: ${(inTotal/1024).toFixed(0)}KB → ${(outTotal/1024).toFixed(0)}KB`)
}

main().catch(console.error)
