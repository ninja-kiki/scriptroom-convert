// 씬 경계를 LLM이 문맥으로 판정한다.
//
//   왜 규칙으로 안 되나: 각본에는 표준이 없다. INT./EXT. 를 안 쓰는 각본(TÁR)이 있고,
//   시간 표시를 안 붙이는 각본이 있고, 대사 안에 대문자와 대시가 들어간 줄도 있다.
//   '구분자가 있을 것 + 끝에 DAY/NIGHT 가 올 것' 같은 규칙은 어느 방향으로든 틀린다
//   (SHARON'S OFFICE 같은 진짜 씬을 놓치고, 인서트 소제목을 씬으로 잡는다).
//
//   그래서 규칙은 '후보 추리기'에만 쓰고, 판정은 앞뒤 문맥을 함께 보여주고 LLM에게 맡긴다.
//   판정 결과는 그대로 적용하지 않고 목록으로 내놓는다 — 적용은 --write 로 명시할 때만.
//
//   사용: node tools/review-scenes.mjs <작품폴더> [--write]
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const SERVER = 'http://localhost:3001'
const work = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!work) { console.error('사용: node tools/review-scenes.mjs <작품폴더> [--write]'); process.exit(1) }

const dir = join(CONTENT, work)
const fmtF = readdirSync(dir).find(f => /_formatted\.txt$/.test(f))
if (!fmtF) { console.error('formatted 없음'); process.exit(1) }
const path = join(dir, fmtF)
const lines = readFileSync(path, 'utf8').split('\n')

// 후보: 이미 씬(#)도 화자(@)도 대사(- )도 괄호도 아닌, 짧고 대문자 위주인 독립 줄.
//   여기서 '씬이다/아니다'를 판단하지 않는다. 판단은 LLM 몫.
const cand = []
lines.forEach((l, i) => {
  const s = l.trim()
  if (!s || /^[#@(]/.test(s) || s.startsWith('- ')) return
  if (s.length > 70) return
  const L = s.replace(/[^A-Za-z]/g, ''), U = s.replace(/[^A-Z]/g, '')
  if (L.length < 4 || U.length / L.length < 0.85) return
  cand.push({ i, text: s })
})
if (!cand.length) { console.log(`${work}: 후보 없음`); process.exit(0) }
console.log(`${work}: 판정 후보 ${cand.length}개`)

// 앞뒤 한 줄씩 붙여 문맥과 함께 묻는다
const ctx = c => {
  const before = lines.slice(Math.max(0, c.i - 2), c.i).map(x => x.trim()).filter(Boolean).slice(-1)[0] || ''
  const after = lines.slice(c.i + 1, c.i + 4).map(x => x.trim()).filter(Boolean)[0] || ''
  return `${c.i}\t${c.text}\t앞:${before.slice(0, 50)}\t뒤:${after.slice(0, 50)}`
}

const GUIDE = `영화 각본에서 '장면(씬)이 바뀌는 자리'를 골라내는 일을 합니다.

아래는 각본 본문에서 뽑은 대문자 줄들입니다. 각 줄은 다음 형식입니다:
줄번호 <탭> 그 줄 <탭> 앞:직전문장 <탭> 뒤:다음문장

각 줄이 '새 장면의 시작'인지 판단하세요.
- 새 장면: 장소나 시간이 바뀌어 카메라가 다른 곳으로 간 것 (예: SHARON'S OFFICE, LADIES ROOM, OUTSIDE THE SAVOY, SOMETIME LATER)
- 새 장면 아님: 같은 장면 안에서 무언가를 클로즈업하거나 강조하는 소제목·인서트 (예: RED VELVET, STACKS OF SCORES, A SERIES OF JUMP CUTS), 소리·음악 묘사, 인물 이름만 있는 것

앞뒤 문장을 근거로 판단하세요. 애매하면 '아님'을 고르세요 — 잘못 쪼개면 한 대화가 두 장면으로 찢어집니다.

출력은 각 줄마다 한 줄씩, 다른 말 없이:
줄번호<탭>YES 또는 NO`

const CHUNK = 60
const verdict = new Map()
for (let s = 0; s < cand.length; s += CHUNK) {
  const part = cand.slice(s, s + CHUNK)
  const res = await fetch(`${SERVER}/api/translate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ formattedText: part.map(ctx).join('\n'), guidelines: GUIDE, sceneIndex: 0, totalScenes: 1 }),
  })
  if (!res.ok) { console.error(`  판정 실패 ${res.status}`); continue }
  const out = ((await res.json()).translated || '').split('\n')
  for (const ln of out) {
    const m = ln.match(/^\s*(\d+)\s*\t?\s*(YES|NO)/i)
    if (m) verdict.set(+m[1], m[2].toUpperCase() === 'YES')
  }
  process.stdout.write(`  ${Math.min(s + CHUNK, cand.length)}/${cand.length}\r`)
}

const yes = cand.filter(c => verdict.get(c.i))
console.log(`\n  새 장면으로 판정 ${yes.length}개 / 후보 ${cand.length}개`)
for (const c of yes.slice(0, 15)) console.log(`     ${c.text.slice(0, 58)}`)
if (yes.length > 15) console.log(`     … 외 ${yes.length - 15}개`)

if (!WRITE) { console.log('\n  (--write 없음 — 적용 안 함)'); process.exit(0) }
for (const c of yes) lines[c.i] = '# ' + c.text
if (!existsSync(path + '.scnbak')) copyFileSync(path, path + '.scnbak')
writeFileSync(path, lines.join('\n'))
console.log(`  ✓ 저장 — 씬 ${lines.filter(l => l.startsWith('# ')).length}개`)
