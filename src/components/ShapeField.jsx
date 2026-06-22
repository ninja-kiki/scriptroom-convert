import { useRef, useEffect } from 'react'
import { T } from '../lib/core.js'

// 자유 부유 파티클 — 홈 포지션 없음. 규칙: 서로 밀어냄 / 마우스 밀어냄 / 벽 튕김 / 느린 브라운 드리프트
export default function ShapeField({ count = 7, size = 48 }) {
  const wrapRef = useRef()

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const r = wrap.getBoundingClientRect()
    const W = r.width || 440, H = r.height || 300
    const COLORS = [T.trans, T.warn, T.fmt]
    const half = size / 2
    const MIN_DIST = size * 2.4   // 도형 간 최소 초기 간격

    // 그리드 셀에 고르게 배치한 뒤 셀 안에서 랜덤 오프셋 — 초기 중앙 몰림 방지
    const cols = Math.ceil(Math.sqrt(count * (W / H)))
    const rows = Math.ceil(count / cols)
    const cellW = (W - size) / cols, cellH = (H - size) / rows
    const shapes = []
    for (let i = 0; i < count; i++) {
      const col = i % cols, row = Math.floor(i / cols)
      const x = half + col * cellW + Math.random() * cellW * 0.7
      const y = half + row * cellH + Math.random() * cellH * 0.7

      const type = i % 3                              // 모양: 0사각 1원 2삼각 — 순서대로
      const color = COLORS[(i + Math.floor(i / 3)) % 3]  // 색: 모양과 어긋나게 배분
      const scale = type === 0 ? 0.8 : 1               // 사각형만 살짝 작게
      const rot = Math.random() * 360
      const speed = 0.3 + Math.random() * 0.4
      const angle = Math.random() * Math.PI * 2
      const el = document.createElement('div')
      el.style.cssText = `position:absolute;left:0;top:0;width:${size}px;height:${size}px;`
        + `background:${color};opacity:.9;will-change:transform;filter:saturate(1.25);`
        // 삼각형: 정삼각형 비율(높이=밑변×0.866)로 세로 줄여 박스 중앙 배치
        + (type === 1 ? 'border-radius:50%;' : type === 0 ? '' : 'clip-path:polygon(50% 6.7%,100% 93.3%,0% 93.3%);')
      el.style.transform = `translate(${x - half}px,${y - half}px) rotate(${rot}deg) scale(${scale})`
      wrap.appendChild(el)
      // driftAngle: 천천히 회전하는 부유 방향, driftSpeed: 각도 변화 속도
      const driftAngle = Math.random() * Math.PI * 2
      const driftSpeed = (0.003 + Math.random() * 0.004) * (Math.random() < 0.5 ? 1 : -1)
      shapes.push({ el, x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, rot, scale, driftAngle, driftSpeed })
    }

    const mouse = { x: -9999, y: -9999 }
    const onMove = (e) => {
      const b = wrap.getBoundingClientRect()
      mouse.x = e.clientX - b.left
      mouse.y = e.clientY - b.top
    }
    window.addEventListener('mousemove', onMove)

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const MOUSE_R = 120, PEER_R = size * 1.6
    const MOUSE_F = 4, PEER_F = 1.5
    const DAMPING = 0.97, MAX_V = 1.6, DRIFT = 0.006

    let raf
    const loop = () => {
      for (let i = 0; i < shapes.length; i++) {
        const p = shapes[i]
        let fx = 0, fy = 0

        // 마우스 반발
        const mx = p.x - mouse.x, my = p.y - mouse.y
        const md2 = mx * mx + my * my
        if (md2 < MOUSE_R * MOUSE_R) {
          const md = Math.sqrt(md2) || 1
          const mf = (1 - md / MOUSE_R) * MOUSE_F
          fx += (mx / md) * mf; fy += (my / md) * mf
        }

        // 도형 간 반발
        for (let j = 0; j < shapes.length; j++) {
          if (i === j) continue
          const q = shapes[j]
          const dx = p.x - q.x, dy = p.y - q.y
          const d2 = dx * dx + dy * dy
          if (d2 < PEER_R * PEER_R && d2 > 0) {
            const d = Math.sqrt(d2)
            const pf = (1 - d / PEER_R) * PEER_F
            fx += (dx / d) * pf; fy += (dy / d) * pf
          }
        }

        // 벽 반발 — 도형 면이 벽에 가까울수록 세게 밀어냄
        const WALL_R = size * 0.5, WALL_F = 2
        const dl = p.x - half, dr = W - p.x - half, dt = p.y - half, db = H - p.y - half
        if (dl < WALL_R) fx += (1 - dl / WALL_R) * WALL_F
        if (dr < WALL_R) fx -= (1 - dr / WALL_R) * WALL_F
        if (dt < WALL_R) fy += (1 - dt / WALL_R) * WALL_F
        if (db < WALL_R) fy -= (1 - db / WALL_R) * WALL_F

        // 부유 드리프트 — 매 프레임 랜덤 대신 천천히 회전하는 방향으로 힘을 줌
        p.driftAngle += p.driftSpeed
        fx += Math.cos(p.driftAngle) * DRIFT
        fy += Math.sin(p.driftAngle) * DRIFT

        p.vx = (p.vx + fx) * DAMPING
        p.vy = (p.vy + fy) * DAMPING

        // 속도 상한
        const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
        if (spd > MAX_V) { p.vx = (p.vx / spd) * MAX_V; p.vy = (p.vy / spd) * MAX_V }

        // 최소 속도 유지 — 멈추지 않게
        if (spd < 0.08) { const a = Math.random() * Math.PI * 2; p.vx += Math.cos(a) * 0.1; p.vy += Math.sin(a) * 0.1 }

        p.x += p.vx; p.y += p.vy

        // 안전망 클램프
        if (p.x < half)     p.x = half
        if (p.x > W - half) p.x = W - half
        if (p.y < half)     p.y = half
        if (p.y > H - half) p.y = H - half

        p.el.style.transform = `translate(${(p.x - half).toFixed(1)}px,${(p.y - half).toFixed(1)}px) rotate(${p.rot}deg) scale(${p.scale})`
      }
      raf = requestAnimationFrame(loop)
    }
    if (!reduce) raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', onMove)
      shapes.forEach(s => s.el.remove())
    }
  }, [count, size])

  return <div ref={wrapRef} aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }} />
}
