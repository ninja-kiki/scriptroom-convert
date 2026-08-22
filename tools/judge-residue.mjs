// 검사기가 '영어 잔재'라고 센 줄을 하나씩 판정한다 — 진짜 미번역인가, 원어로 두는 게 맞나.
//
//   왜 규칙을 더 안 쓰나: 지금까지는 잔재가 나올 때마다 정규식을 하나씩 붙였다.
//   개정 머리글만 15종이 됐고, 스튜디오마다 표기가 달라 끝이 없다. 게다가 규칙은
//   '외국어 대사'와 '미번역 영어'를 구분하지 못한다 — 둘 다 한글이 없는 줄이기 때문이다.
//   그건 문맥을 봐야 아는 일이라 LLM 몫이다.
//
//   판정 결과를 그대로 믿고 지우지 않는다. '원어로 두는 게 맞다'고 한 줄만 근거와 함께
//   .clean-ok 에 적는다(파일이 곧 기록이다). '미번역'이라고 한 줄은 목록으로 내놓는다 —
//   그건 사람이 보거나 다시 번역해야 할 것이지, 조용히 통과시킬 것이 아니다.
//
//   사용: node tools/judge-residue.mjs <작품폴더> [--write]
import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const SERVER = 'http://localhost:3001'
const CHECKER = '/Users/hojun/src-check-clean.py'
const work = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!work) { console.error('사용: node tools/judge-residue.mjs <작품폴더> [--write]'); process.exit(1) }

const dir = join(CONTENT, work)
const file = readdirSync(dir).find(f => f.endsWith('_translated.txt'))
if (!file) { console.error('번역본 없음'); process.exit(1) }
const path = join(dir, file)
const lines = readFileSync(path, 'utf8').split('\n')

// 검사기가 직접 알려준 줄만 다룬다 — 판정 기준이 갈라지지 않도록 같은 코드를 쓴다
const report = execFileSync('python3', [CHECKER, path, '-v'], { encoding: 'utf8' }).trim().split('\n')
const items = []
for (const r of report) {
  const m = r.match(/^(\d+)\t(.*)$/)
  if (!m) continue
  const i = +m[1] - 1
  const before = lines.slice(Math.max(0, i - 6), i).map(x => x.trim()).filter(Boolean).slice(-2)
  const after = lines.slice(i + 1, i + 6).map(x => x.trim()).filter(Boolean).slice(0, 1)
  items.push({ i, text: lines[i].trim(), before, after })
}
if (!items.length) { console.log(`${work}: 잔재 없음`); process.exit(0) }
console.log(`${work}: 판정할 줄 ${items.length}개`)

const GUIDE = `한국어로 번역된 영화 각본에서, 한글이 없는 줄을 하나씩 판정합니다.

각 항목은 이렇게 옵니다:
번호 <탭> 그 줄 <탭> 앞: 앞 문장들 <탭> 뒤: 다음 문장

두 가지 중 하나로 답하세요.

KEEP — 원문 그대로 두는 것이 맞다. 예:
  · 등장인물이 실제로 외국어로 말하는 대사 (스페인어·프랑스어·독일어·이탈리아어 등).
    번역본에서도 그 언어로 남는 것이 정상입니다. 앞뒤 지문에 그 나라·언어가 나오면 근거가 됩니다.
  · 화면에 뜨는 제목·자막 카드 (영화 제목 등)
  · 상표·기관명·주소·URL·노래 제목
  · 사람이 알아들을 수 없는 소리 (외계 생물 울음, 기계음)

DROP — 각본 본문이 아니라 종이에 찍힌 인쇄물이다. 지워야 한다. 예:
  · 개정 머리글 ('BRAD'S STATUS - Blue Revision - Sept 26, 2016 - Page 8')
  · 페이지 번호, 촬영본 표시 ('96.10/25/19 (October Shooting Draft)')
  · 'CONTINUED:' 같은 페이지 이어짐 표시

TODO — 번역했어야 하는데 영어로 남은 것이다. 지문이나 영어 대사.

애매하면 TODO 를 고르세요. 조용히 통과시키는 것보다 사람이 한 번 더 보는 편이 낫습니다.

출력은 각 항목마다 한 줄씩, 다른 말 없이:
번호<탭>KEEP 또는 DROP 또는 TODO<탭>짧은 이유(한국어 15자 이내)`

const fmt = (it) => `${it.i + 1}\t${it.text.slice(0, 90)}\t앞:${it.before.join(' / ').slice(0, 70)}\t뒤:${(it.after[0] || '').slice(0, 50)}`

const CHUNK = 30
const verdict = new Map()
for (let s = 0; s < items.length; s += CHUNK) {
  const part = items.slice(s, s + CHUNK)
  const res = await fetch(`${SERVER}/api/translate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ formattedText: part.map(fmt).join('\n'), guidelines: GUIDE, sceneIndex: 0, totalScenes: 1 }),
  })
  if (!res.ok) { console.error(`  판정 실패 ${res.status}`); continue }
  for (const ln of ((await res.json()).translated || '').split('\n')) {
    const m = ln.match(/^\s*(\d+)\s*\t\s*(KEEP|DROP|TODO)\s*\t?\s*(.*)$/i)
    if (m) verdict.set(+m[1] - 1, { v: m[2].toUpperCase(), why: m[3].trim() })
  }
  process.stdout.write(`  ${Math.min(s + CHUNK, items.length)}/${items.length}\r`)
}

const keep = [], drop = [], todo = []
for (const it of items) {
  const d = verdict.get(it.i)
  if (!d) { todo.push({ ...it, why: '판정 못 받음' }); continue }
  ;(d.v === 'KEEP' ? keep : d.v === 'DROP' ? drop : todo).push({ ...it, why: d.why })
}
console.log(`\n  원어 유지 ${keep.length} · 인쇄물 제거 ${drop.length} · 미번역 ${todo.length}`)
for (const x of todo) console.log(`   [미번역] ${x.text.slice(0, 70)}  — ${x.why}`)
for (const x of drop.slice(0, 4)) console.log(`   [인쇄물] ${x.text.slice(0, 70)}  — ${x.why}`)
for (const x of keep.slice(0, 4)) console.log(`   [원어]   ${x.text.slice(0, 70)}  — ${x.why}`)

if (!WRITE) { console.log('  (--write 없음 — 저장 안 함)'); process.exit(0) }

if (keep.length) {
  const ok = join(dir, '.clean-ok')
  const already = existsSync(ok) ? readFileSync(ok, 'utf8') : ''
  const add = keep.filter(x => !already.includes(x.text)).map(x => `${x.text}\t# ${x.why}`)
  if (add.length) {
    appendFileSync(ok, (already ? '' : '# LLM이 원어 유지가 맞다고 판정한 줄. 뒤의 주석은 그 이유.\n') + add.join('\n') + '\n')
    console.log(`  .clean-ok 에 ${add.length}줄 기록`)
  }
}
if (drop.length) {
  const gone = new Set(drop.map(x => x.i))
  writeFileSync(path, lines.filter((_, i) => !gone.has(i)).join('\n'))
  console.log(`  인쇄물 ${drop.length}줄 삭제`)
}
