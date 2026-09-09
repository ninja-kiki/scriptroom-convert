// 파일을 원자적으로 쓴다 — 임시 파일에 다 쓴 뒤 이름만 바꾼다.
//   writeFileSync 로 직접 덮어쓰면, 쓰는 도중 프로세스가 죽었을 때 파일이 그 지점에서
//   잘린 채 남는다(양들의 침묵: 143씬→18씬, 285KB→46KB). rename 은 원자적이라
//   중간 상태가 없다 — 죽어도 파일은 '바뀌기 전' 아니면 '완전히 바뀐 후' 둘 중 하나다.
//   후처리 체인의 모든 쓰기 도구가 같은 파일을 순서대로 여러 번 덮어쓰므로,
//   그중 하나만 안 지켜도 소용없다 — 전부 이걸로 통일한다.
import { writeFileSync, renameSync, unlinkSync } from 'fs'

export function atomicWrite(path, content) {
  const tmp = path + '.tmp'
  try {
    writeFileSync(tmp, content)
    renameSync(tmp, path)
  } catch (e) { try { unlinkSync(tmp) } catch {} ; throw e }
}
