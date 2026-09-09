// 내용 없는 씬 헤딩('# ')과, 그것 때문에 모델이 뱉은 메타 응답을 걷어낸다.
//
//   무슨 일이 있었나:
//     옛 추출기가 촬영대본의 좌·우 여백 씬번호 줄('105        105')을 씬으로 잡은 뒤
//     앞뒤 번호를 둘 다 떼어, 내용이 없는 '# ' 헤딩을 만들었다(31편·약 300곳).
//     그 빈 씬이 번역기까지 흘러가자 모델이 번역 대신 자기 사정을 설명했다 —
//     '# 생략' · '입력이 `# ` 뿐이므로 그대로 출력합니다'.
//     그 바람에 씬 수가 어긋나(라이트하우스 115→119) --resume 의 씬 정렬이 깨졌고,
//     실패분을 채우려던 재시도가 전부 안전장치에 걸려 아무것도 못 한 채 끝났다.
//
//   지금 추출기는 빈 헤딩을 만들지 않는다(재추출로 확인). 이 도구는 이미 만들어진 파일을 치운다.
//   재추출로 고치지 않는 이유: 재추출하면 그 뒤에 돌린 후처리(큐 복원 등)까지 같이 날아간다.
//
//   사용: node tools/fix-empty-scenes.mjs [<작품폴더>|--all] [--write]
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const only = args.find(a => !a.startsWith('--'))

const EMPTY_HEAD = /^#\s*$/                      // 내용 없는 헤딩
const OMIT_HEAD = /^#\s*생략\s*$/                // 모델이 '# '를 번역해 만든 것
// 모델이 번역 대신 낸 해명. 각본 본문에는 이런 말이 나오지 않는다.
//   한국어로도 영어로도 나온다('The original text to translate contains only:').
const META = /^(입력이|주어진 (입력|텍스트)|이 (입력|줄)은|번역할 (내용|것이))[^\n]*$|그대로 출력(합니다|하겠습니다)|번역할 (내용|것)이 (없|아무)|^The (original|given|input) text( to translate)? (contains|is|consists)/i

// 잘린 씬 헤딩 — PDF에서 두 줄로 접힌 것이 각각 씬이 됐다. 앞이 대시로 끊겼으면 미완성이다.
const DANGLING = /[-–—]\s*$/
// 내용 없는 껍데기 헤딩: 'OMITTED' 를 한국어로 옮긴 것, 후처리가 깎다 만 한두 글자.
const JUNK_HEAD = /^#\s*(삭제됨|생략|[A-Z]{1,2})\s*$/

function fix(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  const out = []
  let heads = 0, metas = 0, joined = 0
  for (const l of lines) {
    const s = l.trim()
    if (EMPTY_HEAD.test(s) || OMIT_HEAD.test(s)) { heads++; continue }
    if (META.test(s)) { metas++; continue }
    // 앞 헤딩이 대시로 끊겼는데 또 헤딩이 오면, 접힌 한 줄이므로 이어붙인다.
    if (/^#\s/.test(s)) {
      let k = out.length - 1
      while (k >= 0 && !out[k].trim()) k--
      if (k >= 0 && /^#\s/.test(out[k].trim()) && DANGLING.test(out[k])) {
        out[k] = out[k].replace(/\s*[-–—]\s*$/, '') + ' - ' + s.replace(/^#\s*/, '').replace(/^\s*[-–—]\s*/, '')
        out.length = k + 1
        joined++
        continue
      }
    }
    out.push(l)
  }
  // 본문 없는 껍데기 헤딩 제거 — 앞뒤가 다 헤딩이거나 파일 끝이면 내용이 없는 것이다.
  const kept = []
  const nonEmpty = out.map(l => l.trim()).filter(Boolean)
  let ni = 0
  for (let i = 0; i < out.length; i++) {
    const t = out[i].trim()
    if (t) {
      if (JUNK_HEAD.test(t) && (ni + 1 >= nonEmpty.length || /^#\s/.test(nonEmpty[ni + 1]))) { heads++; ni++; continue }
      ni++
    }
    kept.push(out[i])
  }
  out.length = 0; out.push(...kept)
  if (!heads && !metas && !joined) return { heads: 0, metas: 0 }
  // 삭제로 생긴 연속 빈 줄을 하나로 — 빈 줄은 이 포맷에서 블록 경계라 개수가 의미를 갖는다.
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
  if (WRITE) {
    if (!existsSync(path + '.esbak')) copyFileSync(path, path + '.esbak')
    writeFileSync(path, text.endsWith('\n') ? text : text + '\n')
  }
  return { heads, metas }
}

const works = only ? [only] : readdirSync(CONTENT).filter(n => {
  if (n.startsWith('.') || n === 'scripts' || n === 'scripts-ocr' || n === 'posters-bauhaus') return false
  try { return statSync(join(CONTENT, n)).isDirectory() } catch { return false }
})

let tH = 0, tM = 0, hit = 0
for (const w of works) {
  let files; try { files = readdirSync(join(CONTENT, w)) } catch { continue }
  const parts = []
  const counts = {}
  for (const [label, re] of [['원문', /_formatted\.txt$/], ['번역', /_translated\.txt$/]]) {
    const f = files.find(x => re.test(x))
    if (!f) continue
    const { heads, metas } = fix(join(CONTENT, w, f))
    if (heads || metas) parts.push(`${label} 헤딩${heads}·메타${metas}`)
    tH += heads; tM += metas
    counts[label] = heads
  }
  if (parts.length) {
    hit++
    // 원문에서 지운 빈 헤딩 수와 번역본에서 지운 수가 다르면 씬 수가 어긋난다 — 사람이 봐야 한다.
    const warn = (counts['원문'] ?? 0) !== (counts['번역'] ?? 0) ? '  ⚠ 원문/번역 삭제 수 불일치' : ''
    console.log(`  ${w.padEnd(40)} ${parts.join(' · ')}${warn}`)
  }
}
console.log(`\n작품 ${hit}편 · 빈헤딩 ${tH} · 메타응답 ${tM}${WRITE ? '  (저장함, 백업 .esbak)' : '  (--write 없음 — 저장 안 함)'}`)
