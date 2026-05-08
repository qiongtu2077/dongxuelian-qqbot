<template>
  <canvas ref="canvasRef" style="position:fixed;inset:0;z-index:9999;pointerEvents:none"></canvas>
</template>

<script>
import { ref, onMounted, onBeforeUnmount } from 'vue'

export default {
  name: 'CursorGlow',
  setup() {
    const canvasRef = ref(null)
    let ctx = null
    let animId = null
    let points = []
    let stars = []
    let frameCount = 0
    let lastMoveTime = 0
    const MAX_POINTS = 50
    const MAX_STARS = 80

    const palette = [
      [57, 197, 187], [90, 234, 212],
      [244, 114, 182], [252, 211, 77], [167, 139, 250],
    ]

    function drawStar(cx, cy, spikes, outerR, innerR, color, alpha) {
      ctx.beginPath()
      for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? outerR : innerR
        const angle = (i * Math.PI) / spikes - Math.PI / 2
        const x = cx + Math.cos(angle) * r
        const y = cy + Math.sin(angle) * r
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`
      ctx.fill()
    }

    function onMove(e) {
      lastMoveTime = Date.now()
      points.push({ x: e.clientX, y: e.clientY })
      if (points.length > MAX_POINTS) points.shift()
    }

    function animate() {
      if (!ctx || !canvasRef.value) return
      const w = canvasRef.value.width
      const h = canvasRef.value.height
      ctx.clearRect(0, 0, w, h)
      frameCount++

      // 鼠标停止后：旧点平滑移向下一个点，靠近后删除
      const idle = Date.now() - lastMoveTime
      if (idle > 200 && points.length > 3) {
        points[0].x += (points[1].x - points[0].x) * 0.1
        points[0].y += (points[1].y - points[0].y) * 0.1
        const dx = points[1].x - points[0].x
        const dy = points[1].y - points[0].y
        if (dx * dx + dy * dy < 1) points.shift()
      }

      // 线条拖尾
      if (points.length > 2) {
        for (let i = 1; i < points.length; i++) {
          const p0 = points[i - 1]
          const p1 = points[i]
          const ratio = i / points.length
          const alpha = ratio * 0.3
          const mix = (i / points.length) * (palette.length - 1)
          const idx = Math.floor(mix)
          const frac = mix - idx
          const c0 = palette[Math.min(idx, palette.length - 1)]
          const c1 = palette[Math.min(idx + 1, palette.length - 1)]
          const r = Math.round(c0[0] + (c1[0] - c0[0]) * frac)
          const g = Math.round(c0[1] + (c1[1] - c0[1]) * frac)
          const b = Math.round(c0[2] + (c1[2] - c0[2]) * frac)
          ctx.beginPath()
          ctx.moveTo(p0.x, p0.y)
          ctx.lineTo(p1.x, p1.y)
          ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`
          ctx.lineWidth = 2
          ctx.lineCap = 'round'
          ctx.stroke()
        }
      }

      // 星星生成（鼠标停止 300ms 后不再生成新星）
      if (points.length > 5 && frameCount % 3 === 0 && stars.length < MAX_STARS && Date.now() - lastMoveTime < 300) {
        const idx = Math.floor(Math.random() * (points.length - 2))
        const src = points[idx]
        stars.push({
          x: src.x + (Math.random() - 0.5) * 8,
          y: src.y + (Math.random() - 0.5) * 8,
          vx: (Math.random() - 0.5) * 0.2,
          vy: -Math.random() * 0.15 - 0.05,
          size: Math.random() * 2.5 + 1,
          spikes: Math.random() > 0.5 ? 4 : 5,
          twinkle: Math.random() * Math.PI * 2,
          twinkleSpeed: Math.random() * 0.04 + 0.02,
          color: palette[Math.floor(Math.random() * palette.length)],
          life: 1,
        })
      }

      // 星星渲染 & 更新
      for (let i = stars.length - 1; i >= 0; i--) {
        const s = stars[i]
        s.x += s.vx
        s.y += s.vy
        s.vy += 0.005
        s.twinkle += s.twinkleSpeed
        s.life -= 0.005
        if (s.life <= 0) { stars.splice(i, 1); continue }

        const blink = 0.5 + 0.5 * Math.sin(s.twinkle)
        const alpha = s.life * 0.7 * blink
        const size = s.size * (0.4 + 0.6 * s.life)

        drawStar(s.x, s.y, s.spikes, size, size * 0.45, s.color, alpha)
      }

      animId = requestAnimationFrame(animate)
    }

    function resize() {
      if (!canvasRef.value) return
      canvasRef.value.width = window.innerWidth
      canvasRef.value.height = window.innerHeight
    }

    onMounted(() => {
      if (canvasRef.value) ctx = canvasRef.value.getContext('2d')
      resize()
      window.addEventListener('resize', resize)
      window.addEventListener('mousemove', onMove)
      animate()
    })

    onBeforeUnmount(() => {
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMove)
      cancelAnimationFrame(animId)
    })

    return { canvasRef }
  }
}
</script>
