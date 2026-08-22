// 페이지마다 찍힌 워터마크(내려받은 사이트 URL 등)를 본문에서 떼어낸다.
//
//   왜 필요한가: 스크립트 배포 사이트가 페이지 하단에 URL 도장을 찍어 배포한다.
//   PDF에서 글자를 뽑으면 그 URL이 본문 줄 한복판에 섞여 들어온다 —
//   '—holding on MERRY JANE WATSON, ... /139https://app.studiobinder.com/... A BLACK SCREEN'
//   줄을 통째로 지우면 진짜 지문까지 날아가므로, 그 토큰만 도려내야 한다.
//
//   어떻게 고르나: 사이트 이름을 코드에 적지 않는다(다음 각본은 다른 사이트에서 온다).
//   '같은 URL이 문서 전체에 여러 번 나오면 페이지 장식'이라는 데이터 기준만 쓴다.
//   본문에 진짜로 나오는 URL(대사 속 유튜브 링크 등)은 한두 번뿐이라 걸리지 않는다.
//
//   사용: node tools/strip-watermark.mjs <작품폴더> [--write]
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const work = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!work) { console.error('사용: node tools/strip-watermark.mjs <작품폴더> [--write]'); process.exit(1) }

// URL 을 품은 '공백 없는 덩어리' 전체를 한 토큰으로 본다.
//   앞에 페이지 번호 조각이 달라붙어 오기 때문이다('/139https://…').
const TOKEN = /\S*https?:\/\/\S+/g
const KEYLEN = 40   // 끝부분은 잘린 정도가 제각도 제각각이라 앞머리로만 같은 URL인지 본다
const MIN_HITS = 5  // 페이지마다 찍히는 것이면 이보다 훨씬 많이 나온다

// URL이 아닌 순수 텍스트 도장도 있다('©2023 DISNEY•PIXAR - PRIVILEGED AND CONFIDENTIAL').
//   줄 전체가 이 형태('© 연도 배급사 - ALL CAPS 문구')면 도장으로 본다.
const STAMP_LINE = /^©?\s*\d{0,4}\s*[A-Z][A-Za-z0-9&.•' -]{2,60}[-–—]\s*[A-Z][A-Z ,.'-]{4,60}$/

const dir = join(CONTENT, work)
let changedAny = false

for (const kind of ['_formatted.txt', '_translated.txt']) {
  const file = readdirSync(dir).find(f => f.endsWith(kind))
  if (!file) continue
  const path = join(dir, file)
  let text = readFileSync(path, 'utf8')

  // 0) 순수 텍스트 도장('©2023 DISNEY•PIXAR - PRIVILEGED AND CONFIDENTIAL') —
  //    독립된 한 줄로 5회 이상 반복되면 도장으로 보고, 그 문구가 어디에 박혀 있든
  //    (독립된 줄이든, 대사 한복판이든) 지운다. 대사 한복판에 낀 경우가 더 위험하다
  //    ('- ©2023 DISNEY... 뭐, 얘가 나만큼 빠르진 못할 거야' 처럼 진짜 대사를 깨뜨린다).
  //   ★도장이 대사 한복판에 낄 때는 그 줄 전체가 도장 모양이 아니다('- ©2023 ... CONFIDENTIAL 뭐, 얘가...').
  //   그래서 판정(도장 문구가 몇 번 나오는지)과 제거(그 문구가 어디 박혀 있든 지운다)를 나눈다.
  //   판정은 '독립된 줄' 기준으로만 세면 낀 경우를 놓치므로, 문구가 등장하는 모든 자리를 센다.
  const stampFreq = new Map()
  for (const l of text.split('\n')) {
    const s = l.trim()
    if (STAMP_LINE.test(s)) { stampFreq.set(s, (stampFreq.get(s) || 0) + 1); continue }
    for (const [stamp] of stampFreq) if (s.includes(stamp)) stampFreq.set(stamp, stampFreq.get(stamp) + 1)
  }
  let stampRemoved = 0
  for (const [stamp, n] of stampFreq) {
    if (n < 3) continue
    console.log(`  ${kind}: 텍스트 도장 ${n}회 — ${stamp.slice(0, 50)}…`)
    const before = text
    text = text.split('\n').map(l => {
      if (l.trim() === stamp) { stampRemoved++; return '' }          // 독립된 줄
      if (l.includes(stamp)) { stampRemoved++; return l.replace(stamp, '').replace(/\s{2,}/g, ' ').trim() }  // 대사 속에 낌
      return l
    }).join('\n')
  }

  // 1) 반복되는 URL 앞머리를 센다
  const hits = new Map()
  for (const m of text.matchAll(TOKEN)) {
    const url = m[0].slice(m[0].indexOf('http'))
    const key = url.slice(0, KEYLEN)
    hits.set(key, (hits.get(key) || 0) + 1)
  }
  const marks = [...hits.entries()].filter(([, n]) => n >= MIN_HITS)
  // ★URL 워터마크가 없다고 여기서 바로 나가면 안 된다 — 위에서 찾은 텍스트 도장 제거분이
  //   저장 단계까지 못 가고 통째로 버려진다(elemental 에서 실제로 이렇게 놓쳤다).
  if (!marks.length) {
    console.log(`  ${kind}: URL 워터마크 없음`)
    if (stampRemoved) {
      const cleaned = text.replace(/[ \t]{2,}/g, ' ').split('\n').filter(l => !/^(#|@|-)\s*$/.test(l.trim())).join('\n').replace(/\n{3,}/g, '\n\n')
      console.log(`  ${kind}: ${stampRemoved}개 제거`)
      if (WRITE) { if (!existsSync(path + '.wmbak')) copyFileSync(path, path + '.wmbak'); writeFileSync(path, cleaned); changedAny = true }
    }
    continue
  }
  for (const [key, n] of marks) console.log(`  ${kind}: ${n}회 — ${key}…`)

  // 2) 그 앞머리를 가진 토큰만 도려낸다
  const keys = new Set(marks.map(([k]) => k))
  let removed = 0
  let out = text.replace(TOKEN, tok => {
    const url = tok.slice(tok.indexOf('http'))
    if (!keys.has(url.slice(0, KEYLEN))) return tok
    removed++
    return ''
  })

  // 3) 도려낸 자리에 생긴 겹공백을 먼저 없앤다.
  //    ★이걸 뒤에 하면 안 된다. 워터마크가 빠진 자리에 공백이 두 칸 남아서
  //    '같은 문장이 두 번' 판정이 글자 하나 차이로 빗나간다(19/38만 잡혔다).
  let lines2 = out.split('\n').map(l => l.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, ''))

  // 4) 워터마크를 걷어내면 '같은 문장이 두 번 찍힌' 자리가 드러난다.
  //    도장을 찍는 도구가 페이지를 다시 그리면서 줄 앞머리를 한 번 더 남긴 것이다
  //    ('—holding on MERRY JANE WATSON, sad eyes, ' + 같은 말 + 이어지는 문장).
  //    두 번째 복사본이 항상 첫 번째와 똑같지는 않다 — 첫 복사본이 화면에 보이던 데까지만
  //    찍히고 잘려 있기도 하다('…바로 그때 he' + 온전한 문장). 그래서 '똑같이 두 번'을
  //    찾지 않고, '줄이 제 앞머리(20자)를 다시 시작하면 그 앞은 버린다'로 본다.
  //    20자면 우연히 겹칠 일이 없고, 이 정리는 워터마크가 발견된 문서에서만 돈다.
  const HEAD = 20
  let dedup = 0
  lines2 = lines2.map(l => {
    const m = l.match(/^(\s*(?:# |@|- )?)(.*)$/)
    const head = m[1], s = m[2].trimEnd()
    if (s.length < HEAD * 2) return l
    const again = s.indexOf(s.slice(0, HEAD), 1)
    if (again < HEAD) return l
    dedup++
    return head + s.slice(again)
  })
  if (dedup) console.log(`  ${kind}: 두 번 찍힌 줄 ${dedup}개 정리`)

  // 5) 마커('# ', '@', '- ')만 남은 줄은 내용이 사라진 것이므로 통째로 없앤다.
  out = lines2.filter(l => !/^(#|@|-)\s*$/.test(l.trim()))
    .join('\n').replace(/\n{3,}/g, '\n\n')

  removed += stampRemoved
  console.log(`  ${kind}: ${removed}개 제거`)
  if (WRITE && removed) {
    if (!existsSync(path + '.wmbak')) copyFileSync(path, path + '.wmbak')
    writeFileSync(path, out)
    changedAny = true
  }
}
if (!WRITE) console.log('  (--write 없음 — 저장 안 함)')
else if (!changedAny) console.log('  변경 없음')
