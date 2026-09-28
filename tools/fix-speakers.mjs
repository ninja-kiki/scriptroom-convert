// 화자(인물큐) 오류 교정 — 모델 호출 없음.
//   번역 모델이 앞뒤 지문의 흐름에 끌려 인물큐를 '그 씬의 다른 등장인물'로 바꿔 적는 일이 있다
//   (인셉션: 원문 @COBB 대사를 '@사이토'로 — 바로 위 지문 '코브가 사이토 옆으로 다가온다'를 따라감).
//   재번역해도 같은 실수를 반복해서, 이름은 모델에 맡기지 않고 여기서 결정적으로 맞춘다.
//
// 안전 조건: 영어·한국어 씬의 블록 종류 순서(헤딩·인물·대사·괄호·지문)가 완전히 같을 때만 손댄다.
//   그래야 n번째 인물큐의 대사가 원문 n번째 대사의 번역이라고 확신할 수 있다(짝이 밀린 씬은 건드리면 더 망가진다).
//   바꾸는 건 '그 씬의 다른 등장인물 이름으로 들어간 큐'뿐 — 표기 흔들림(애그니스/아그네스)은 건드리지 않는다.
//
//   사용: node tools/fix-speakers.mjs <작품폴더|--all> [--write]
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { atomicWrite } from './_atomic-write.mjs'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const args = process.argv.slice(2)
const WRITE = args.includes('--write'), ALL = args.includes('--all')
const only = args.find(a => !a.startsWith('--'))
if (!ALL && !only) { console.error('사용: node tools/fix-speakers.mjs <작품폴더|--all> [--write]'); process.exit(1) }

const kind = l => l.startsWith('#') ? 'S' : l.startsWith('@') ? 'C' : l.startsWith('- ') ? 'D' : (l.startsWith('(') && l.endsWith(')')) ? 'P' : 'A'
const name = l => l.replace(/^@/, '').replace(/\([^)]*\)/g, '').replace(/\*/g, '').trim()
// 씬 = '# ' 헤딩부터 다음 헤딩 전까지. 각 줄은 {i: 파일 줄번호, s: 내용}
function scenes(lines) {
  const out = [[]]
  lines.forEach((l, i) => { const s = l.trim(); if (!s) return; if (s.startsWith('# ')) out.push([]); out[out.length - 1].push({ i, s }) })
  return out
}
const pick = (dir, re) => { try { return readdirSync(dir).find(x => re.test(x)) } catch { return null } }
const works = ALL ? readdirSync(CONTENT).filter(n => !n.startsWith('.') && statSync(join(CONTENT, n)).isDirectory()) : [only]
let total = 0
for (const w of works) {
  const dir = join(CONTENT, w)
  const fm = pick(dir, /_formatted\.txt$/), tr = pick(dir, /_translated\.txt$/)
  if (!fm || !tr) continue
  const A = scenes(readFileSync(join(dir, fm), 'utf8').split('\n'))
  const L = readFileSync(join(dir, tr), 'utf8').split('\n')
  const B = scenes(L)
  if (A.length !== B.length) continue
  const same = A.map((a, k) => a.map(x => kind(x.s)).join('') === B[k].map(x => kind(x.s)).join(''))
  // 작품 전체 '영문 이름 → 주 번역명' (구조가 같은 씬에서만 모은다)
  const count = new Map()
  A.forEach((a, k) => { if (!same[k]) return; a.forEach((x, j) => { if (kind(x.s) !== 'C') return
    const e = name(x.s), ko = name(B[k][j].s); if (!/[가-힣]/.test(ko)) return
    const m = count.get(e) || new Map(); m.set(ko, (m.get(ko) || 0) + 1); count.set(e, m) }) })
  const dict = new Map([...count].map(([e, m]) => { const top = [...m].sort((p, q) => q[1] - p[1])[0]; return [e, top[1] >= 2 ? top[0] : null] }).filter(([, v]) => v))
  const fixes = []
  A.forEach((a, k) => {
    if (!same[k]) return
    const sceneNames = new Set(a.filter(x => kind(x.s) === 'C').map(x => dict.get(name(x.s))).filter(Boolean))
    a.forEach((x, j) => {
      if (kind(x.s) !== 'C') return
      const want = dict.get(name(x.s)), got = B[k][j]
      const have = name(got.s)
      if (!want || have === want || !sceneNames.has(have)) return
      const nl = got.s.replace(have, want)
      fixes.push({ line: got.i + 1, from: got.s, to: nl, en: x.s })
      L[got.i] = L[got.i].replace(got.s, nl)
    })
  })
  if (!fixes.length) continue
  total += fixes.length
  console.log(`${w}: 화자 교정 ${fixes.length}곳`)
  for (const f of fixes.slice(0, 8)) console.log(`   ${f.line}행 ${f.from} → ${f.to}   (원문 ${f.en})`)
  if (WRITE) atomicWrite(join(dir, tr), L.join('\n'))
}
console.log(`\n총 ${total}곳${WRITE ? '' : '  (--write 없음 — 저장 안 함)'}`)
