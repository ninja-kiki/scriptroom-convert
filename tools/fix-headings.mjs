// 남은 영어 씬 헤딩만 골라 번역해 교체한다.
//   왜 따로 두나: 씬 전체를 재번역해도 LLM이 헤딩 한 줄을 영어로 남기는 일이 반복된다(Leon·mid90s 등).
//   씬 전체를 또 돌리는 건 비싸고 효과도 없어서, 헤딩 줄만 모아 작품당 1회 호출로 처리한다.
//   사용: node tools/fix-headings.mjs <작품폴더> [--write]
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const SERVER = 'http://localhost:3001'
const work = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!work) { console.error('사용: node tools/fix-headings.mjs <작품폴더> [--write]'); process.exit(1) }

const dir = join(CONTENT, work)
const trFile = readdirSync(dir).find(f => /_translated\.txt$/.test(f))
if (!trFile) { console.error('_translated.txt 없음'); process.exit(1) }
const path = join(dir, trFile)
const text = readFileSync(path, 'utf8')
const lines = text.split('\n')

// 영어로 남은 헤딩 수집 (한글이 전혀 없고 알파벳이 충분한 '# ' 줄)
const targets = []
lines.forEach((l, i) => {
  const s = l.trim()
  if (!/^#\s/.test(s)) return
  if (/[가-힣]/.test(s)) return
  if (s.replace(/[^A-Za-z]/g, '').length < 4) return
  targets.push({ i, text: s })
})

if (!targets.length) { console.log(`${work}: 영어 헤딩 없음`); process.exit(0) }
console.log(`${work}: 영어 헤딩 ${targets.length}개`)
targets.slice(0, 5).forEach(t => console.log(`   ${t.text}`))

const sys = `당신은 영화 각본 번역가입니다. 주어진 '씬 헤딩' 줄들만 한국어로 번역하세요.

규칙(엄수):
- 입력의 각 줄을 1:1로 번역해 같은 줄 수로 출력. 설명·번호·따옴표 금지.
- 맨 앞 '# ' 는 구조 마커다. 그대로 유지한다.
- INT.→내부. / EXT.→외부. / INT./EXT.→내부/외부. 로 옮긴다(마침표 유지).
- 장소명·시간대도 한국어로: COURTHOUSE→법원, KITCHEN→주방, DAY→낮, NIGHT→밤, DAWN→새벽, SUNRISE→일출, CONTINUOUS→연속, LATER→나중에.
- 고유명사(인물명·지명)는 통용 한국어 표기로. 아파트 호수·숫자는 그대로.
- INSERT/INTERCUT/MONTAGE/SERIES OF SHOTS 는 인서트/인터컷/몽타주/시리즈 오브 샷 으로 음차.

순수 텍스트만 출력하세요.`

const res = await fetch(`${SERVER}/api/translate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    formattedText: targets.map(t => t.text).join('\n'),
    guidelines: sys, sceneIndex: 0, totalScenes: 1,
  }),
})
if (!res.ok) { console.error(`번역 실패: ${res.status}`); process.exit(1) }
const out = ((await res.json()).translated || '').trim().split('\n').map(s => s.trim()).filter(Boolean)

// 줄 수가 어긋나면(LLM이 줄을 쪼개거나 붙임) 통짜 매칭은 위험하므로 한 줄씩 개별 번역으로 전환한다.
//   예전엔 그냥 포기해서 영어 헤딩이 그대로 남았다(the-incredible 13개).
if (out.length !== targets.length) {
  console.warn(`  줄 수 불일치(${out.length} ≠ ${targets.length}) — 한 줄씩 개별 번역으로 전환`)
  out.length = 0
  for (const t of targets) {
    try {
      const r = await fetch(`${SERVER}/api/translate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formattedText: t.text, guidelines: sys, sceneIndex: 0, totalScenes: 1 }),
      })
      const one = r.ok ? ((await r.json()).translated || '').trim().split('\n').map(s => s.trim()).filter(Boolean)[0] : ''
      out.push(one || t.text)
    } catch { out.push(t.text) }
  }
}
// 번역 결과가 여전히 영어면 그 줄은 건너뛴다(잘못 덮어쓰지 않도록)
let applied = 0
out.forEach((ko, k) => {
  if (!/[가-힣]/.test(ko)) return
  // ★한자 혼입 교정: 모델이 '내부'를 '内부/内部'처럼 한자로 쓰는 일이 실제로 있었다(barbie).
  //   한국어 각본에 한자가 들어가면 안 되므로 치환하고, 그래도 남으면 그 줄은 적용하지 않는다.
  ko = ko.replace(/内部|内부/g, '내부').replace(/外部|外부/g, '외부')
  if (/[一-鿿]/.test(ko)) { console.warn(`  ⚠ 한자 남아 건너뜀: ${ko}`); return }
  if (!/^#\s/.test(ko)) ko = '# ' + ko.replace(/^#*\s*/, '')
  lines[targets[k].i] = ko
  applied++
})
console.log(`  → 교체 ${applied}/${targets.length}개`)
targets.slice(0, 3).forEach((t, k) => console.log(`   ${t.text}  →  ${lines[t.i]}`))

if (WRITE && applied) {
  if (!existsSync(path + '.headbak')) copyFileSync(path, path + '.headbak')
  writeFileSync(path, lines.join('\n'))
  console.log(`  ✓ 저장 (백업: .headbak)`)
} else if (!WRITE) {
  console.log('  (--write 없음 — 저장 안 함)')
}
