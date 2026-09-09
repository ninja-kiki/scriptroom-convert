import { atomicWrite } from './_atomic-write.mjs'
// 번역본에 남은 '러닝 헤더/개정 표시' 잔재를 제거한다.
//   예: 'The Martian Shooting Script 14.', 'BEEF "The Birds Don't Sing..." 4.',
//       'BLUE WIP REVISIONS SZ EPISODE 1 12.', "BRAD'S STATUS - Pink Revision - Sept. 5 - Page 22"
//   PDF 페이지마다 반복되는 머리글인데 추출에서 못 걸러져 본문에 섞였다(29편).
//   사용: node tools/strip-running-header.mjs <작품폴더> [--write]
//
// 안전 원칙: '같은 문구가 3회 이상 반복되는 영어 줄'만 지운다.
//   숫자만 다른 경우를 같은 문구로 보되(페이지번호), 씬헤딩(#)·인물큐(@)·대사(- )는 절대 안 건드린다.
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!work) { console.error('사용: node tools/strip-running-header.mjs <작품폴더> [--write]'); process.exit(1) }

const dir = join(CONTENT, work)
const trFile = readdirSync(dir).find(f => /_translated\.txt$/.test(f))
if (!trFile) { console.error('_translated.txt 없음'); process.exit(1) }
const path = join(dir, trFile)
const lines = readFileSync(path, 'utf8').split('\n')

const hasKo = s => /[가-힣]/.test(s)
// ★씬 헤딩(#)·인물 큐(@)·괄호 지시문은 절대 건드리지 않는다.
//   대사 마커('- ')는 예전엔 여기 포함시켜 아예 후보에서 뺐는데, 그러면 머리글이 대사로
//   잘못 분류된 경우를 영영 못 지운다(나를 찾아줘: '- GG - Blue Draft - 8/29/13 10.' 가
//   쪽마다 남았다). 대신 조건을 하나 건다 — 번역본에서 한글이 없는 줄만 후보로 본다.
//   진짜 대사라면 번역돼 한글이 있다. 한글 없이 똑같은 문구가 세 번 넘게 반복되면 그건 머리글이다.
const isStructural = s => /^[#@]/.test(s) || /^\(/.test(s)
// 숫자(페이지번호)와 따옴표·대시 모양 차이를 무시하고 같은 문구로 본다.
//   같은 헤더인데 곧은따옴표/굽은따옴표가 섞여 다른 패턴으로 세어지는 일이 있었다(Beef).
const norm = s => s
  .replace(/[""«»]/g, '"').replace(/['']/g, "'").replace(/[—–]/g, '-')
  .replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()

// 후보: 구조줄이 아니고 한글 없고 알파벳 충분한 줄
const freq = new Map()
for (const l of lines) {
  const s = l.trim()
  if (s.length < 20 || hasKo(s) || isStructural(s)) continue
  // ★알파벳 15자 이상을 요구했더니 짧은 머리글이 빠져나갔다('GG - Blue Draft - 8/29/13 10.' 은 11자).
  //   판단 근거는 글자 수가 아니라 '한글 없이 똑같은 문구가 세 번 넘게 반복된다'는 사실이다.
  if (s.replace(/[^A-Za-z]/g, '').length < 8) continue
  const k = norm(s)
  freq.set(k, (freq.get(k) || 0) + 1)
}
const boiler = new Set([...freq].filter(([, c]) => c >= 3).map(([k]) => k))

if (!boiler.size) { console.log(`${work}: 반복 헤더 없음`); process.exit(0) }

const removed = []
const out = []
for (let i = 0; i < lines.length; i++) {
  const s = lines[i].trim()
  if (s.length >= 20 && s.replace(/[^A-Za-z]/g, '').length >= 8 && !hasKo(s) && !isStructural(s) && boiler.has(norm(s))) {
    removed.push(s)
    if (lines[i + 1] !== undefined && !lines[i + 1].trim()) i++   // 뒤 빈 줄도 같이
    continue
  }
  out.push(lines[i])
}

console.log(`${work}: 러닝 헤더 잔재 ${removed.length}건 (패턴 ${boiler.size}종)`)
;[...boiler].slice(0, 3).forEach(b => console.log(`   패턴: ${b.slice(0, 70)}`))
if (WRITE && removed.length) {
  if (!existsSync(path + '.hdrbak')) copyFileSync(path, path + '.hdrbak')
  atomicWrite(path, out.join('\n'))
  console.log(`  ✓ 저장 (백업: .hdrbak)`)
} else if (!WRITE) {
  console.log('  (--write 없음 — 저장 안 함)')
}
