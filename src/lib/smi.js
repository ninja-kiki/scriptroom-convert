// SMI 파싱 + 번역-자막 매칭

// 자막 파일 디코딩 (UTF-8 우선, 깨지면 EUC-KR/CP949 폴백)
export async function decodeSubtitle(file) {
  const buf = await file.arrayBuffer()
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) }
  catch {
    try { return new TextDecoder('euc-kr').decode(buf) }
    catch { return new TextDecoder('utf-8').decode(buf) }
  }
}

// SMI / SRT / 평문 → 깨끗한 자막 줄 배열 (타임코드·태그 제거)
export function parseSubtitleLines(text) {
  let t = (text || '').replace(/\r/g, '')
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
export function validateSMI(entries) {
  if (!entries || entries.length < 5) {
    return { ok: false, reason: `한국어 자막이 ${entries?.length ?? 0}줄밖에 없어요. SMI 파일이 비어있거나 한글 자막이 아닐 수 있어요.` }
  }
  return { ok: true }
}

// 텍스트 정규화 (유사도 계산용)
function normalize(s) {
  return s.replace(/[\s.,!?~·…'"「」『』【】《》\-_]/g, '').toLowerCase()
}

// 각본 번역 ↔ 공식 자막 유사도.
// 둘 다 '번역물'이라 같은 뜻이어도 단어·어순·어미가 달라 글자 자카드는 과소평가됨.
// → ① 바이그램 오버랩계수(길이패널티 제거)와 ② 토큰 함유율(어순 무관 핵심어 겹침)의 최댓값.
function similarity(a, b) {
  const na = normalize(a), nb = normalize(b)
  if (!na || !nb || na.length < 2 || nb.length < 2) return 0
  const bigrams = s => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const ba = bigrams(na), bb = bigrams(nb)
  let inter = 0
  ba.forEach(g => { if (bb.has(g)) inter++ })
  const overlap = inter / Math.min(ba.size, bb.size)   // 자카드 대신 오버랩계수(짧은 자막 불이익 제거)

  // 정확 토큰(2글자+ 내용어) 함유율 — 어순·어미 달라도 핵심어 겹치면 인정 (substring 아님 = 우연 매칭 방지)
  const tok = s => s.split(/\s+/).map(normalize).filter(t => t.length >= 2)
  const ta = tok(a), tb = tok(b)
  let tokenSim = 0
  if (ta.length && tb.length) {
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
    const longSet = new Set(long)
    tokenSim = short.filter(t => longSet.has(t)).length / short.length
  }
  // 길이 호환성: 진짜 짝은 길이가 비슷함. 짧은 줄이 거대한 자막 풀에서 우연히 겹치는 것 억제.
  const lenRatio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length)
  return Math.max(overlap, tokenSim) * Math.min(1, lenRatio * 1.5)
}

// 번역 텍스트 + SMI 엔트리 → 교체 + 매치 데이터
export function matchSmiToTranslation(translatedText, smiEntries, threshold = 0.35) {
  if (!smiEntries || smiEntries.length === 0) {
    return { text: translatedText, matches: [] }
  }

  const lines = translatedText.split('\n')
  const matches = [] // { lineIdx, original, smiText, similarity, replaced }
  let afterCharCue = false

  const result = lines.map((line, idx) => {
    const trimmed = line.trim()

    // 캐릭터 큐 → 다음 라인부터 대사
    if (trimmed.startsWith('@')) { afterCharCue = true; return line }
    // 씬 헤딩, 빈 줄 → 대사 블록 종료
    if (trimmed.startsWith('#') || trimmed === '') { afterCharCue = false; return line }
    // 괄호 지문 → 대사 블록 유지, 매칭 안 함
    if (trimmed.startsWith('(')) return line
    // 한국어 없으면 스킵
    if (!/[가-힣]/.test(trimmed)) return line
    // 대사 블록 아니면 스킵 (지문)
    if (!afterCharCue) return line

    // 최적 SMI 매치 탐색
    let bestSim = 0, bestEntry = null
    for (const entry of smiEntries) {
      const sim = similarity(trimmed, entry)
      if (sim > bestSim) { bestSim = sim; bestEntry = entry }
    }

    if (bestSim >= threshold) {
      matches.push({ lineIdx: idx, original: trimmed, smiText: bestEntry, similarity: bestSim, replaced: true })
      return bestEntry
    } else {
      matches.push({ lineIdx: idx, original: trimmed, smiText: bestEntry, similarity: bestSim, replaced: false })
      return line
    }
  })

  return { text: result.join('\n'), matches }
}
