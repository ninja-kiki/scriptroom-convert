// 번역본에 '원문(영어) + 번역(한국어)'이 나란히 남은 중복을 제거한다.
//   왜 필요한가: 재번역을 반복해도 LLM이 원문을 지우지 않고 번역을 덧붙이는 경우가 있다(127hours 등 36편).
//   리더에서 같은 내용이 영어·한글로 두 번 보이는 원인.
//   사용: node tools/dedup-source.mjs <작품폴더> [--write]
//
// 안전 원칙 — 애매하면 지우지 않는다:
//   · 지문(액션)만 대상. 씬헤딩(#)·인물큐(@)·대사(- )는 건드리지 않는다.
//   · 바로 다음 문단이 한국어일 때만 지운다(번역이 실제로 존재하는 경우).
//   · 영어로 보이는 줄만 — 불어·이탈리아어 등 의도적 원어 대사는 영어 불용어가 없으므로 남는다.
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!work) { console.error('사용: node tools/dedup-source.mjs <작품폴더> [--write]'); process.exit(1) }

const dir = join(CONTENT, work)
const trFile = readdirSync(dir).find(f => /_translated\.txt$/.test(f))
if (!trFile) { console.error('_translated.txt 없음'); process.exit(1) }
const path = join(dir, trFile)
const lines = readFileSync(path, 'utf8').split('\n')

const hasKo = s => /[가-힣]/.test(s)
// 영어 문장인가 — 흔한 영어 기능어가 있어야 영어로 본다(불어·이탈리아어 오삭제 방지)
const EN_STOP = /\b(the|and|is|are|was|were|to|of|in|on|at|it|he|she|they|you|with|for|that|this|his|her|from|but|not|have|has|had|will|would|can|be|as|by|we|a|an|into|out|up|down|then|now|still|like|all|no|back|over|off|through|after|before)\b/i
const isStructural = s => /^[#@]/.test(s) || /^-\s/.test(s) || /^\(/.test(s)

const removed = []
const out = []
for (let i = 0; i < lines.length; i++) {
  const s = lines[i].trim()

  // ①-b 구조줄 중복: 영어 헤딩/큐 바로 뒤에 같은 것의 한국어판이 오는 경우
  //   (예: '# INT. CANYON. DAY' 다음 '# 내부. 협곡. 낮.', '@ARON' 다음 '@아론')
  //   LLM이 원문을 지우지 않고 번역을 덧붙인 결과 — 영어 쪽을 버린다.
  if (/^[#@]/.test(s) && !hasKo(s) && s.replace(/[^A-Za-z]/g, '').length >= 3) {
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    const next = j < lines.length ? lines[j].trim() : ''
    if (next && hasKo(next) && next[0] === s[0]) {   // 같은 종류(# ↔ #, @ ↔ @)
      removed.push(s)
      if (lines[i + 1] !== undefined && !lines[i + 1].trim()) i++
      continue
    }
  }
  const isEnglishAction =
    s.length >= 25 && !hasKo(s) && !isStructural(s) &&
    s.replace(/[^A-Za-z]/g, '').length >= 20 && EN_STOP.test(s)

  if (isEnglishAction) {
    // 다음 '비어있지 않은' 줄이 한국어 지문이면 이 영어 줄은 원문 잔재 → 제거
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    const next = j < lines.length ? lines[j].trim() : ''
    if (next && hasKo(next) && !isStructural(next) && next.length >= 15) {
      removed.push(s)
      // 이 줄과 뒤따르는 빈 줄 하나를 같이 제거해 문단 간격 유지
      if (lines[i + 1] !== undefined && !lines[i + 1].trim()) i++
      continue
    }
  }
  out.push(lines[i])
}

console.log(`${work}: 원문 잔재 ${removed.length}건`)
removed.slice(0, 3).forEach(s => console.log(`   삭제: ${s.slice(0, 70)}`))
if (WRITE && removed.length) {
  if (!existsSync(path + '.dedupbak')) copyFileSync(path, path + '.dedupbak')
  writeFileSync(path, out.join('\n'))
  console.log(`  ✓ 저장 (백업: .dedupbak)`)
} else if (!WRITE) {
  console.log('  (--write 없음 — 저장 안 함)')
}
