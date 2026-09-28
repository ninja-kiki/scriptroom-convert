// 번역기가 번역 대신 '자기 작업'을 말한 문장(메타 응답) 탐지 — 서버·재번역이 같이 쓰는 한 벌.
//   같은 규칙이 두 군데 더 복제돼 있다: ~/src-check-clean.py(게이트), scriptroom/scripts/sync-sources.js(빌드 경고).
//   여기를 고치면 그 둘도 같이 고친다 — 기준이 어긋나면 게이트는 잡는데 --resume 이 그 씬을 재사용한다.
//
// 판별 원칙(정밀도 우선):
//   · 각본 본문에 나올 수 없는 형태('입력이 …뿐이므로 그대로 출력합니다', '[번역할 원문]', ``` 등)는 어느 줄이든
//   · 지문·헤딩은 '~한다'체라서, 대사(- )·인물큐(@)가 아닌 줄이 '번역합니다/옮기겠습니다'체면 번역기의 말
//     (대사 속 '제가 번역해 드리겠습니다'는 정상 — 건드리지 않는다)

const ANY = /(입력|원문|텍스트|번역할\s*(원문|내용|텍스트))[^\n]{0,40}(이므로|뿐이므로|없으므로)[^\n]{0,25}(출력|옮기|옮깁|유지|번역)|번역할\s*(내용|것|텍스트|원문)이\s*(없|아무)|^\[?\s*(번역|번역할\s*원문|씬\s*헤딩을\s*번역)\s*:?\s*\]?\s*$|^(의|을|를)\s*번역|번역\s*대상이|규칙에\s*따라\s*처리|^\*?\(?\s*참고[:：]?\s*(위|이|아래)\s*(장면|대사|씬|원문)에는|^```|노이즈 제거 — 원문 취소선 표시|저작권이?\s*있는[^\n]{0,60}(옮겨|번역해|재생산해)\s*(드릴|드리)\s*수|원하시면[^\n]{0,40}번역|<\/?(system|user|assistant|human)>|^<br\s*\/?>$/
const NON_DIALOGUE = /(번역|출력)(하겠습니다|했습니다|합니다|해\s*드리|드리겠)|옮기겠습니다|옮깁니다|옮겼습니다|옮겨\s*드리|(이것|부분)\s*번역\.?\s*$|번역\s*시작\.?\s*$/

export function metaLeak(line) {
  const s = String(line || '').trim()
  if (!s) return false
  if (ANY.test(s)) return true
  return !/^(- |@)/.test(s) && NON_DIALOGUE.test(s)
}

export function findMetaLeaks(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(metaLeak)
}

// 모델이 프롬프트의 라벨을 되풀이해 첫 줄에 붙이는 것('번역할 원문:', '번역:', ```)만 떼어낸다.
//   각본 첫 줄이 이런 모양일 수는 없으므로 결정적으로 안전하다. 본문 중간의 메타는 여기서 안 건드린다.
const ECHO = /^(\[?\s*번역할\s*원문\s*\]?\s*:?|\[?\s*번역\s*\]?\s*:?|```[a-z]*)$/
export function stripEchoLabel(text) {
  const lines = String(text || '').split('\n')
  while (lines.length && (!lines[0].trim() || ECHO.test(lines[0].trim()))) lines.shift()
  while (lines.length && (!lines[lines.length - 1].trim() || /^```$/.test(lines[lines.length - 1].trim()))) lines.pop()
  return lines.join('\n')
}

// 번역할 내용이 없는 씬(OMITTED 표시·빈 헤딩뿐) — 모델에 보내면 '그대로 출력합니다'라고 설명을 한다.
export function hasNothingToTranslate(text) {
  const ls = String(text || '').split('\n').map(l => l.trim()).filter(Boolean)
  return ls.length > 0 && ls.every(l => /^#\s*([0-9]+[A-Z]?\s*)?(OMIT\w*|DELETED)?\s*([0-9]+[A-Z]?)?\s*$/i.test(l))
}
