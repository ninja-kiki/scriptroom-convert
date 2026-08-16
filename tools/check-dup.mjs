// content 폴더에서 같은 작품이 두 번 들어와 있는지 찾는다.
//   ★예전 검사는 '정규화 후 길이 비율 0.7 이상'을 요구했다. 그 바람에
//   'Guillermo-del-Toro's-Pinocchio' 와 'Guillermo-del-Toro's-Pinocchio-2022' 처럼
//   연도만 붙은 쌍을 놓쳤다(127hours/127-hours-2010, Roma/roma-2018도 같은 이유).
//   이제는 '연도를 떼고 영숫자만 남긴 것'이 완전히 같으면 중복으로 본다.
//
//   사용: node tools/check-dup.mjs
import { readdirSync, statSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const SKIP = new Set(['scripts', 'scripts-ocr', 'posters-bauhaus'])
const norm = s => s.toLowerCase().replace(/-?(19|20)\d{2}$/, '').replace(/[^a-z0-9]/g, '')

const groups = new Map()
for (const d of readdirSync(CONTENT)) {
  if (SKIP.has(d) || d.startsWith('.')) continue
  try { if (!statSync(join(CONTENT, d)).isDirectory()) continue } catch { continue }
  const k = norm(d)
  if (!k) continue
  ;(groups.get(k) || groups.set(k, []).get(k)).push(d)
}

let n = 0
for (const [k, list] of groups) {
  if (list.length < 2) continue
  n++
  console.log(`[${k}]`)
  for (const d of list) {
    const files = readdirSync(join(CONTENT, d))
    const tr = files.find(f => /_translated\.txt$/.test(f))
    const scenes = tr ? (readFileSync(join(CONTENT, d, tr), 'utf8').match(/^# /gm) || []).length : 0
    const poster = files.some(f => /^poster\./i.test(f))
    const cleanOk = existsSync(join(CONTENT, d, '.clean-ok'))
    console.log(`   ${d.padEnd(46)} 씬 ${String(scenes).padStart(4)}${poster ? ' · poster' : ''}${cleanOk ? ' · .clean-ok' : ''}`)
  }
}
console.log(n ? `\n중복 ${n}쌍 — poster·.clean-ok 가 있는 쪽이 손본 이력이 있는 폴더다` : '중복 없음')
