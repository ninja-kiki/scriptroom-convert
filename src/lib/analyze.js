/**
 * PDF 씬 분석 — 업로드 직후 경고/정보 생성
 * level: 'error' | 'warn' | 'info'
 */

// 원본 텍스트에서 INT./EXT. 헤딩 줄 수 추출 (씬 번호 prefix + OCR 잡티 허용)
function countRawHeadings(rawText) {
  const lines = rawText.split('\n')
  const hit = (t) =>
    /^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.)/i.test(t) ||
    /^[A-Z]?\d+\.?\s+(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.)/i.test(t) ||
    /^SCENE\s+\d+\s*[-–.]/i.test(t)
  return lines.filter(line => {
    const t = line.trim()
    const deSpeck = t.replace(/^[A-Za-z0-9*'"\\\/|.\-]{1,3}\s{2,}/, '')  // 앞쪽 OCR 잡티 제거
    return hit(t) || hit(deSpeck)
  }).length
}

function firstLine(scene) {
  return scene.raw.split('\n').find(l => l.trim())?.trim() || ''
}

function isRecognizedHeading(line) {
  return (
    /^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.)/i.test(line) ||
    /^#\s*(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.)/i.test(line) ||
    /^[A-Z]?\d+\.?\s+(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.)/i.test(line) ||
    /^SCENE\s+\d+\s*[-–.]/i.test(line) ||
    /^(INSERT|INTERCUT|MONTAGE|SERIES OF SHOTS)/i.test(line)
  )
}

export function analyzeScenes(scenes, rawText) {
  const warnings = []
  const total = scenes.length
  if (total === 0) return warnings

  const totalLines = scenes.reduce((acc, s) => acc + s.raw.split('\n').length, 0)

  // ── 1. 씬 수 너무 적음 ──────────────────────────────────
  if (total === 1) {
    warnings.push({
      level: 'error',
      code: 'single_scene',
      label: '씬 분리 실패 의심 — 씬 1개',
      detail: `전체 각본이 씬 1개(${totalLines}줄)로 인식되었습니다. 씬 헤딩 형식이 비표준이거나 PDF 텍스트 추출이 제대로 되지 않았을 수 있습니다. 이대로 변환 시 토큰 초과 오류가 발생할 가능성이 높습니다.`,
    })
  } else if (total <= 4) {
    warnings.push({
      level: 'warn',
      code: 'few_scenes',
      label: `씬 수 매우 적음 — ${total}개`,
      detail: '씬 헤딩 형식이 일반적이지 않거나 일부가 누락되었을 수 있습니다. 아래 씬 목록을 확인해 주세요.',
    })
  }

  // ── 2. 원본 헤딩 수 vs 인식 씬 수 비교 ─────────────────
  const rawHeadingCount = countRawHeadings(rawText)
  if (rawHeadingCount > 0 && total < rawHeadingCount * 0.4 && total < rawHeadingCount - 3) {
    warnings.push({
      level: 'warn',
      code: 'undercount',
      label: `씬 인식 부족 — 원본 헤딩 ${rawHeadingCount}개 중 ${total}개 인식`,
      detail: `원본에서 INT./EXT. 헤딩이 ${rawHeadingCount}개 발견되었지만 ${total}개 씬만 분리되었습니다. 씬 번호 형식이나 특수 문자로 인해 일부 헤딩이 누락되었을 수 있습니다.`,
    })
  }

  // ── 3. 강제 분할 씬 ──────────────────────────────────────
  const forceSplitCount = scenes.filter(s => (s.forceSplit || s.raw.split('\n').length > 80)).length
  if (forceSplitCount > 0) {
    warnings.push({
      level: 'info',
      code: 'force_split',
      label: `긴 씬 ${forceSplitCount}개 자동 분할 처리`,
      detail: `80줄 넘는 긴 씬은 처리 단위로 나눠서 돌려요. 최종 결과물에선 다시 하나로 이어지니 씬 번호·내용엔 영향 없어요.`,
    })
  }

  // ── 4. 평균 씬 크기 이상 ─────────────────────────────────
  if (total > 1) {
    const avgLines = Math.round(totalLines / total)
    if (avgLines > 120) {
      warnings.push({
        level: 'warn',
        code: 'large_avg',
        label: `평균 씬 크기 큼 — 씬당 평균 ${avgLines}줄`,
        detail: '씬당 평균 줄 수가 높습니다. 일부 씬이 제대로 분리되지 않아 묶여 있을 수 있습니다.',
      })
    }
  }

  // ── 5. 씬 번호 prefix 형식 감지 (info — 자동 처리됨) ────
  const numberedCount = scenes.filter(s =>
    /^[A-Z]?\d+\.?\s+(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.)/i.test(firstLine(s))
  ).length
  if (numberedCount > 0) {
    warnings.push({
      level: 'info',
      code: 'numbered_headings',
      label: `씬 번호 prefix 형식 감지 — ${numberedCount}개`,
      detail: '"19 EXT. LOCATION" 또는 "A19 INT. ROOM" 형식의 씬 번호 prefix가 포함되어 있습니다. 포맷 단계에서 자동으로 제거됩니다.',
    })
  }

  // ── 6. SCENE N - INT. 비표준 형식 (info) ─────────────────
  const sceneFormatCount = scenes.filter(s =>
    /^SCENE\s+\d+\s*[-–.]/i.test(firstLine(s))
  ).length
  if (sceneFormatCount > 0) {
    warnings.push({
      level: 'info',
      code: 'scene_n_format',
      label: `SCENE N 형식 감지 — ${sceneFormatCount}개`,
      detail: '"SCENE 3 - INT. ROOM" 형식이 감지됩니다. 포맷 단계에서 표준 형식으로 정리됩니다.',
    })
  }

  // ── 7. 헤딩 인식률 낮음 (씬 2번째부터 체크) ─────────────
  if (total > 6) {
    // 첫 씬은 크레딧/타이틀일 수 있으므로 제외
    const checkable = scenes.slice(1)
    const recognized = checkable.filter(s => isRecognizedHeading(firstLine(s))).length
    const ratio = recognized / checkable.length
    if (ratio < 0.35 && !warnings.some(w => w.code === 'single_scene' || w.code === 'few_scenes' || w.code === 'undercount')) {
      warnings.push({
        level: 'warn',
        code: 'low_heading_ratio',
        label: `헤딩 인식률 낮음 — ${checkable.length}개 씬 중 ${recognized}개 (${Math.round(ratio * 100)}%)`,
        detail: '씬 첫 줄이 INT./EXT. 형식으로 시작하지 않는 씬이 많습니다. 씬 목록에서 구조를 확인해 주세요.',
      })
    }
  }

  return warnings
}
