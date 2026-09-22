// 후처리 파이프라인 도구들(retranslate/fix-*/strip-*)이 첫 수정 전에 남기는
// 일회성 안전백업(*.retbak · *.hpbak · *.cuebak · *.mcbak · *.shbak · ...)을 정리한다.
//   검증(src-check-clean 0, 커밋 완료)까지 끝난 작품은 git 히스토리가 이미
//   최종 상태를 갖고 있어 이 백업들이 더 이상 필요 없다 — 그냥 두면 무한히 쌓인다.
//   (2026-09, content/ 전체에 536개 87MB 쌓여있던 걸 한 번에 정리한 뒤 생긴 도구)
//
//   사용: node tools/clean-backups.mjs <작품폴더|--all> [--write]
//   기본은 미리보기(개수·용량만 출력, 삭제 안 함). --write 로 실제 삭제.
import { readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

const CONTENT = '/Users/hojun/Projects/scriptroom/content'
const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const ALL = args.includes('--all')
const only = args.find(a => !a.startsWith('--'))
if (!ALL && !only) { console.error('사용: node tools/clean-backups.mjs <작품폴더|--all> [--write]'); process.exit(1) }

const works = ALL
  ? readdirSync(CONTENT).filter(n => { if (n.startsWith('.')) return false; try { return statSync(join(CONTENT, n)).isDirectory() } catch { return false } })
  : [only]

let count = 0, bytes = 0
for (const w of works) {
  const dir = join(CONTENT, w)
  let files
  try { files = readdirSync(dir) } catch { continue }
  for (const f of files) {
    if (!/bak/.test(f)) continue
    const p = join(dir, f)
    let sz = 0
    try { sz = statSync(p).size } catch { continue }
    count++; bytes += sz
    if (WRITE) unlinkSync(p)
  }
}
const mb = (bytes / 1024 / 1024).toFixed(1)
console.log(`${WRITE ? '삭제' : '대상'} ${count}개 · ${mb}MB${WRITE ? '' : '  (--write 없음 — 삭제 안 함)'}`)
