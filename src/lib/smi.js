// SMI 파싱 + 번역-자막 매칭

// 자막 파일 디코딩. UTF-16(BOM/무BOM) → UTF-8 → EUC-KR/CP949 순.
// ※ UTF-16을 EUC-KR로 잘못 읽으면 글자마다 널 바이트가 끼어 spawn이 죽음 → 반드시 먼저 감지.
export async function decodeSubtitle(file) {
  const buf = await file.arrayBuffer()
  const b = new Uint8Array(buf)
  // 1) BOM 명시
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf)
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(buf)
  // 2) UTF-8 시도
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) }
  catch {
    // 3) BOM 없는 UTF-16 추정: 앞부분에 널 바이트가 많으면 (짝수=LE, 홀수=BE)
    const n = Math.min(b.length, 4000)
    let evenZero = 0, oddZero = 0, zeros = 0
    for (let i = 0; i < n; i++) if (b[i] === 0) { zeros++; (i % 2 ? oddZero++ : evenZero++) }
    if (zeros > n * 0.15) return new TextDecoder(oddZero > evenZero ? 'utf-16le' : 'utf-16be').decode(buf)
    // 4) EUC-KR/CP949
    try { return new TextDecoder('euc-kr').decode(buf) }
    catch { return new TextDecoder('utf-8').decode(buf) }
  }
}

// SMI / SRT / 평문 → 깨끗한 자막 줄 배열 (타임코드·태그 제거)
export function parseSubtitleLines(text) {
  // 널 바이트·BOM·제어문자 제거 (잘못 디코딩된 자막 방어 — \t \n 만 보존)
  let t = (text || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFEFF]/g, '').replace(/\r/g, '')
  if (/<SYNC/i.test(t)) {
    // SMI
    t = t.replace(/<SYNC[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ')
  } else if (/-->/.test(t)) {
    // SRT: 인덱스 줄·타임코드 줄 제거
    t = t.split('\n').filter(l => !/^\d+$/.test(l.trim()) && !l.includes('-->')).join('\n')
    t = t.replace(/<[^>]+>/g, '')
  }
  return t.split('\n').map(l => l.trim()).filter(Boolean)
}

// 자막 언어·줄수 감지 (불러올 때 표시용)
export function subtitleInfo(lines) {
  const joined = (lines || []).join('')
  const hangul = (joined.match(/[가-힣]/g) || []).length
  const latin = (joined.match(/[A-Za-z]/g) || []).length
  const ratio = hangul / (hangul + latin || 1)
  const lang = ratio > 0.2 ? 'ko' : (latin > 0 ? 'en' : 'unknown')
  return { lang, count: (lines || []).length, hangul, latin }
}

// SMI → 한국어 대사 라인 배열
export function parseSMIEntries(text) {
  const cleaned = text
    .replace(/<SYNC[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\r/g, '')
  return cleaned
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 1 && /[가-힣]/.test(l)) // 한국어 포함 라인만
}

// SMI 유효성 검사
