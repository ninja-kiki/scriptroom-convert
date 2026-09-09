import { atomicWrite } from './_atomic-write.mjs'
// 반쪽만 번역된 씬 헤딩을 마저 옮긴다.
//
//   왜 이런 게 남았나: 검사기는 '한글이 한 글자라도 있으면 통과'시킨다. 그래서
//   '내부. MOTEL ROOM 21 - DAY' 처럼 앞머리만 한국어가 된 헤딩이 전부 깨끗함으로 통과했다
//   (107편 1,025개). 대사·지문은 멀쩡하므로 각본을 다시 번역할 일은 아니다 — 헤딩만 옮긴다.
//
//   왜 규칙으로 안 바꾸나: 'ROOM'→'호실', 'DAY'→'낮' 식의 낱말 표를 만들면
//   'MOTEL ROOM 21'이 '모텔 호실 21'이 된다. 장소 이름은 문맥을 봐야 옮겨진다.
//
//   사용: node tools/translate-headings.mjs <작품폴더> [--write]
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const SERVER = 'http://localhost:3001'
const work = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!work) { console.error('사용: node tools/translate-headings.mjs <작품폴더> [--write]'); process.exit(1) }

const EN_WORD = /\b[A-Za-z][A-Za-z']{1,}\b/g
const needsWork = (s) => (s.match(EN_WORD) || []).length >= 3

const dir = join(CONTENT, work)
const file = readdirSync(dir).find(f => f.endsWith('_translated.txt'))
if (!file) { console.error('번역본 없음'); process.exit(1) }
const path = join(dir, file)
const lines = readFileSync(path, 'utf8').split('\n')
// ★번역 배치가 같은 파일을 쓰고 있을 수 있다. 읽어둔 뒤 오래 걸리는 API 호출을 하고
//   그대로 덮어쓰면, 그 사이 배치가 완성한 번역을 낡은 사본으로 밀어버린다
//   (디재스터 아티스트가 그렇게 0줄에서 295줄로 되돌아갔다). 쓰기 직전에 다시 확인한다.
const mtimeAtRead = statSync(path).mtimeMs

const targets = [...new Set(lines.filter(l => l.startsWith('# ') && needsWork(l.slice(2).trim())).map(l => l.slice(2).trim()))]
if (!targets.length) { console.log(`${work}: 손볼 헤딩 없음`); process.exit(0) }
console.log(`${work}: 헤딩 ${targets.length}종`)

// ★인물 이름은 본문에서 이미 정해진 표기를 따라야 한다. 그러지 않으면 헤딩만 따로 논다
//   ('PADRAIC'S HOUSE' 를 파드릭의 집으로 옮겼는데 본문 화자는 275번 파우릭이었다).
//   원문·번역본의 화자 목록을 그대로 넘겨 짝을 맞추게 한다.
const cueList = (f) => {
  const p = readdirSync(dir).find(x => x.endsWith(f))
  if (!p) return []
  const c = {}
  for (const l of readFileSync(join(dir, p), 'utf8').split('\n')) {
    if (!l.startsWith('@')) continue
    const n = l.slice(1).replace(/\((?:CONT'?D|V\.?O\.?|O\.?S\.?)[^)]*\)/gi, '').trim()
    if (n) c[n] = (c[n] || 0) + 1
  }
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k]) => k)
}
const NAMES = `\n\n이 작품의 인물 이름은 이미 이렇게 적고 있습니다 — 헤딩의 사람 이름도 반드시 이 표기를 따르세요.\n원문: ${cueList('_formatted.txt').join(', ')}\n번역: ${cueList('_translated.txt').join(', ')}`

const GUIDE = `영화 각본의 '씬 헤딩'(장면 제목)을 한국어로 옮깁니다.

입력은 한 줄에 헤딩 하나입니다. 앞부분만 한국어로 바뀌고 나머지가 영어로 남아 있는 것들입니다.

지켜야 할 것:
- 줄 수와 순서를 그대로 유지하세요. 입력이 N줄이면 출력도 N줄입니다.
- '내부.'/'외부.' 표기는 그대로 두세요. 'INT.'/'EXT.'가 남아 있으면 '내부.'/'외부.'로 바꾸세요.
- 장소는 한국어로 옮기세요. 사람 이름이 든 장소는 소리 나는 대로 적습니다
  (COLM'S HOUSE → 콜름의 집, VAN BUREN ESTATE → 밴 뷰런 저택).
- 시간은 한국어로 옮기세요 (DAY → 낮, NIGHT → 밤, LATER → 잠시 후, CONTINUOUS → 계속, DAWN → 새벽).
- 헤딩 끝에 붙은 씬 번호와 개정 표시(*)는 그대로 두세요.
- 설명이나 사족을 붙이지 마세요. 옮긴 헤딩만 출력합니다.` + NAMES

const CHUNK = 40
const map = new Map()
for (let s = 0; s < targets.length; s += CHUNK) {
  const part = targets.slice(s, s + CHUNK)
  const res = await fetch(`${SERVER}/api/translate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ formattedText: part.join('\n'), guidelines: GUIDE, sceneIndex: 0, totalScenes: 1 }),
  })
  if (!res.ok) { console.error(`  번역 실패 ${res.status}`); continue }
  const out = ((await res.json()).translated || '').split('\n').map(x => x.trim()).filter(Boolean)
  // 줄 수가 어긋나면 짝을 믿을 수 없다 — 통째로 버린다(엉뚱한 헤딩을 심는 것보다 낫다)
  if (out.length !== part.length) { console.error(`  줄 수 불일치 ${out.length}≠${part.length} — 이 묶음 버림`); continue }
  // ★한자가 한글 자리에 끼어 나오는 일이 있다 — '내부.'가 '内부.'로 나왔다(4편).
  //   괄호 안 병기('가(家)', '전전(戰前)')는 정상 한국어 표기이므로 그건 놔두고,
  //   괄호 밖 한자만 거른다. 원문에 이미 한자가 있었다면 그건 옮긴 게 아니라 원문이다.
  const strayHanja = (s, src) => /[一-鿿]/.test(s.replace(/\([^)]*\)/g, '')) && !/[一-鿿]/.test(src)
  part.forEach((k, i) => {
    if (!out[i] || out[i] === k) return
    if (strayHanja(out[i], k)) { console.error(`  한자 섞임 — 버림: ${out[i].slice(0, 40)}`); return }
    map.set(k, out[i])
  })
  process.stdout.write(`  ${Math.min(s + CHUNK, targets.length)}/${targets.length}\r`)
}

let n = 0
const outLines = lines.map(l => {
  if (!l.startsWith('# ')) return l
  const k = l.slice(2).trim()
  if (!map.has(k)) return l
  n++
  return '# ' + map.get(k)
})
console.log(`\n  ${n}줄 교체 (${map.size}종)`)
for (const [a, b] of [...map].slice(0, 5)) console.log(`     ${a.slice(0, 46)}  →  ${b.slice(0, 46)}`)
if (!WRITE) { console.log('  (--write 없음 — 저장 안 함)'); process.exit(0) }
if (!n) process.exit(0)
if (statSync(path).mtimeMs !== mtimeAtRead) {
  console.error('  다른 작업이 이 파일을 고쳤다 — 덮어쓰지 않는다')
  process.exit(0)
}
if (!existsSync(path + '.hdbak')) copyFileSync(path, path + '.hdbak')
atomicWrite(path, outLines.join('\n'))
console.log('  ✓ 저장')
