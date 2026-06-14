import { useState, useEffect } from 'react'
import { T, fmtDuration, fmtTokens, loadSettings } from '../lib/core.js'
import SceneCard from './SceneCard.jsx'

// 오류 메시지를 사람이 읽는 '종류'로 분류
function classifyError(msg) {
  const m = (msg || '').toLowerCase()
  if (!msg) return { key: 'unknown', label: '알 수 없는 오류', hint: '재시도해 보세요' }
  if (/설치되어 있지 않|claude_not_found|claude code.*설치|cli를 찾을/.test(m)) return { key: 'noclaude', label: 'Claude Code 미설치', hint: 'claude.com/claude-code 에서 설치하세요' }
  if (/로그인이? 필요|\bauth\b|not logged|please.*login|unauthorized|invalid api key|credentials/.test(m)) return { key: 'auth', label: 'Claude 로그인 필요', hint: '터미널에서 `claude` 실행 → 로그인 후 재개하세요' }
  if (/load failed|failed to fetch|networkerror|network error|err_/.test(m)) return { key: 'network', label: '네트워크 끊김 (Load failed)', hint: '서버가 바빠 브라우저 요청이 끊긴 것 — 재시도하면 서버가 이어서 처리해요' }
  if (/null byte/.test(m)) return { key: 'nullbyte', label: '자막 인코딩 오류 (널 바이트)', hint: '자막을 다시 올려 변환하면 해결돼요' }
  if (/rate.?limit|usage limit|quota|too many/.test(m)) return { key: 'rate', label: 'Claude 사용량 한도', hint: '한도가 풀린 뒤 재개하세요' }
  if (/timeout|timed out|etimedout/.test(m)) return { key: 'timeout', label: '시간 초과', hint: '재시도하세요' }
  if (/exit code|spawn|enoent/.test(m)) return { key: 'proc', label: 'claude 프로세스 오류', hint: '재시도하세요' }
  return { key: 'other:' + m.slice(0, 24), label: msg.slice(0, 44), hint: '' }
}

export default function ProcessPanel({ title, scenes, phase, startTime, isPaused, isRateLimited, characterMemo, isServerJob, onSaveGlossary, onRetranslate, onPause, onResume, onStop, onContinue, onRetry, onReprocess, onDownload, onReset, onReader, onReport }) {
  const [expandedId, setExpandedId] = useState(null)
  const [filter, setFilter] = useState('all')  // all | warn | error
  const [glossOpen, setGlossOpen] = useState(false)
  const [glossDraft, setGlossDraft] = useState(null)  // null=폴링값 따라감, 문자열=편집중
  const [dlMsg, setDlMsg] = useState({ type: null, msg: '' })  // 저장 버튼 일시 피드백

  // 테마(live T) 따라가도록 컴포넌트 안에서 정의
  const ctrlBtn = {
    padding: '6px 13px', borderRadius: 3,
    background: T.chip, border: 'none',
    color: T.fgMuted, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
  }
  const dlBtn = {
    flex: 1, padding: '10px 14px', borderRadius: 3,
    background: T.chip, border: 'none',
    color: T.fg, fontSize: 13, cursor: 'pointer', fontWeight: 600,
  }
  // 색 버튼: 중립 칩 + 색 글씨 (색 틴트 박스 금지)
  const tintBtn = (c) => ({ ...ctrlBtn, color: c })
  // 솔리드 버튼: 색 채움 + 흰 글씨 (강조 액션)
  const solidBtn = (c) => ({ ...dlBtn, background: c, color: '#fff' })

  const isWarnScene = (s) => {
    if (s.status.startsWith('error')) return true
    if (s.smiMatches?.length) {
      const m = s.smiMatches.filter(x => x.aligned).length
      if (m / s.smiMatches.length < 0.3) return true
    }
    return false
  }
  const matchFilter = (s) => filter === 'all' ? true : filter === 'error' ? s.status.startsWith('error') : isWarnScene(s)
  const warnSceneCount = scenes.filter(isWarnScene).length

  // 오류·경고 종류별 집계 (모아보기)
  const errorGroups = (() => {
    const g = new Map()
    for (const s of scenes) {
      if (!s.status?.startsWith('error')) continue
      const c = classifyError(s.error)
      if (!g.has(c.key)) g.set(c.key, { ...c, ids: [] })
      g.get(c.key).ids.push(s.id)
    }
    return [...g.values()].sort((a, b) => b.ids.length - a.ids.length)
  })()
  const lowSmiIds = scenes.filter(s => { const m = s.smiMatches; return m?.length && m.filter(x => x.aligned).length / m.length < 0.3 }).map(s => s.id)

  // 논리적 씬 번호 맵 (이어짐 조각은 부모 번호 공유) — 목록·보고서 공용
  const logicalNoOf = (() => { const m = {}; let n = 0; for (const s of scenes) { if (!s.forceSplit) n++; m[s.id] = n } return m })()
  const ruleFmtCount = scenes.filter(s => s.formatMethod === 'rule').length

  const total = scenes.length
  const doneCount = scenes.filter(s => s.status === 'done').length
  const errCount = scenes.filter(s => s.status.startsWith('error')).length
  const { totalIn, totalOut } = scenes.reduce((acc, s) => {
    if (!s.tokens) return acc
    return {
      totalIn: acc.totalIn + (s.tokens.format_in || 0) + (s.tokens.translate_in || 0),
      totalOut: acc.totalOut + (s.tokens.format_out || 0) + (s.tokens.translate_out || 0),
    }
  }, { totalIn: 0, totalOut: 0 })
  const totalTokens = totalIn + totalOut
  // claude-sonnet: $3/MTok input, $15/MTok output
  const costUsd = (totalIn * 3 + totalOut * 15) / 1_000_000
  const fmtCost = costUsd < 0.01 ? '<$0.01' : `$${costUsd.toFixed(2)}`

  // 전체 자막 매칭 요약 (한글 자막 사용 시)
  let smiAttempts = 0, smiMatched = 0
  for (const s of scenes) {
    if (!s.smiMatches?.length) continue
    smiAttempts += s.smiMatches.length
    smiMatched += s.smiMatches.filter(m => m.aligned).length
  }
  const smiPct = smiAttempts > 0 ? Math.round((smiMatched / smiAttempts) * 100) : null
  // 정렬률은 '검토 참고' 지표 — 낮아도 정상(각본≠영화 자막)이라 빨강 경보 안 씀
  const smiColor = smiPct == null ? T.fgMuted : smiPct >= 50 ? T.accent : T.fgMuted

  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0
  const isDone = doneCount === total && total > 0
  const hasIncomplete = phase === 'done' && scenes.some(s => s.status !== 'done')

  // 경과시간 1초마다 갱신 (작업 중에만)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (isDone || phase === 'done') return
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [isDone, phase])

  return (
    <div style={{ padding: '24px 16px', maxWidth: 640, margin: '0 auto' }}>
      {isRateLimited && (
        <div style={{
          background: T.warn + '22', border: `1px solid ${T.warn}`,
          borderRadius: 3, padding: '14px 18px', marginBottom: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div>
            <div style={{ color: T.warn, fontWeight: 700, fontSize: 14, marginBottom: 2 }}>Claude 사용량 한도 초과</div>
            <div style={{ color: T.fgMuted, fontSize: 13 }}>잠시 후 한도가 풀리면 재개 버튼을 눌러주세요.</div>
          </div>
          <button className="sr-press" onClick={onResume} style={{ ...ctrlBtn, color: T.warn, borderColor: T.warn, whiteSpace: 'nowrap' }}>재개</button>
        </div>
      )}
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <h2 style={{ color: T.fg, fontSize: 18, fontWeight: 700 }}>{title}</h2>
          <span style={{ color: T.fgMuted, fontSize: 13 }}>{doneCount}/{total} 씬</span>
          {phase !== 'done' && !isPaused && <span style={{ color: T.warn, fontSize: 12, fontWeight: 600 }}>{phase === 'formatting' ? '포맷 중' : phase === 'register' ? '말투 분석 중' : '번역 중'}</span>}
          {isPaused && <span style={{ color: T.warn, fontSize: 12 }}>일시정지됨</span>}
        </div>

        {/* Progress bar */}
        <div style={{ height: 6, background: T.rule, borderRadius: 3, marginBottom: 10, overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: 3, width: `${pct}%`,
            background: errCount > 0 ? T.err : isDone ? T.accent : T.warn, transition: 'width .3s' }} />
        </div>

        {/* Stat badges */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Badge>{pct}%</Badge>
          {startTime && <Badge>{fmtDuration(Date.now() - startTime)}</Badge>}
          {totalTokens > 0 && <Badge title="LLM 입출력 추정치 (규칙·자막 직결분 제외)">~{fmtTokens(totalTokens)} 토큰</Badge>}
          {ruleFmtCount > 0 && <Badge title="규칙으로 포맷 — LLM 안 씀(0토큰)">규칙포맷 {ruleFmtCount}씬</Badge>}
          {smiPct != null && <Badge color={smiColor} title={`공식 자막과 정렬된 대사 ${smiMatched}/${smiAttempts} (검토 참고 — 낮아도 정상)`}>자막정렬 {smiPct}%</Badge>}
          {errCount > 0 && <Badge color={T.err}>오류 {errCount}</Badge>}
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {phase !== 'done' && !isPaused && (
          <button className="sr-press" onClick={onPause} style={ctrlBtn} title="잠깐 멈춤 — 재개하면 그 자리에서 이어서 계속">일시정지</button>
        )}
        {phase !== 'done' && isPaused && (
          <button className="sr-press" onClick={onResume} style={tintBtn(T.good)}>재개</button>
        )}
        {phase !== 'done' && (
          <button className="sr-press" onClick={() => { if (window.confirm('작업을 중단할까요? 진행된 씬은 유지됩니다.')) onStop() }} style={tintBtn(T.err)} title="작업 종료 — 진행된 씬은 보존, 다시 하려면 '이어하기'">중단</button>
        )}
        {hasIncomplete && (
          <button className="sr-press" onClick={onContinue} style={tintBtn(T.accent)}>이어하기</button>
        )}
        {doneCount > 0 && (
          <button className="sr-press" onClick={onReader} style={tintBtn(T.accent)}
            title="완료된 씬을 화살표로 넘기며 읽기 (변환 중에도 가능)">리더 모드</button>
        )}
        {onReport && (
          <button className="sr-press" onClick={onReport} title="이 작업의 처리 정보를 로그에 기록 (문제 추적용)"
            style={{ background: 'none', border: 'none', color: T.fgDim, fontSize: 12, cursor: 'pointer', marginLeft: 'auto', textDecoration: 'underline' }}>문제 리포트</button>
        )}
      </div>

      {/* 말투 가이드 (자막 근거) — 보기·편집·다시 번역 */}
      {isServerJob && (characterMemo || phase === 'done' || phase === 'translating') && (
        <div style={{ marginBottom: 16, borderRadius: 3, overflow: 'hidden', background: T.chip }}>
          <div onClick={() => setGlossOpen(o => !o)}
            style={{ padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: T.fg }}>말투 가이드 <span style={{ color: T.fgDim, fontWeight: 400, fontSize: 11.5 }}>· 자막 근거 인물별 반말/존댓말·호칭</span></span>
            <span style={{ color: T.fgDim, fontSize: 11 }}>{glossOpen ? '▲' : '▼'}</span>
          </div>
          {glossOpen && (
            <div style={{ padding: '0 14px 12px' }}>
              <textarea value={glossDraft ?? characterMemo ?? ''} onChange={e => setGlossDraft(e.target.value)}
                placeholder="아직 말투 가이드가 없습니다 (번역 시작 시 자동 생성)"
                style={{ width: '100%', boxSizing: 'border-box', minHeight: 140, resize: 'vertical', background: T.bgInput, border: `1px solid ${T.rule}`, borderRadius: 3, color: T.fg, fontSize: 12.5, lineHeight: 1.65, padding: 10, fontFamily: 'inherit' }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button className="sr-press" disabled={glossDraft === null} onClick={() => { onSaveGlossary(glossDraft); setGlossDraft(null) }}
                  style={{ ...ctrlBtn, opacity: glossDraft === null ? 0.4 : 1 }}>저장</button>
                <button className="sr-press" onClick={() => { if (window.confirm('현재 말투 가이드로 전체를 다시 번역할까요? 기존 번역을 새로 덮어쓰고 토큰을 씁니다.')) onRetranslate(true) }}
                  style={tintBtn(T.accent)}>이 가이드로 다시 번역</button>
                <button className="sr-press" onClick={() => { if (window.confirm('말투 가이드를 자막 근거로 새로 만들고 전체를 다시 번역할까요?')) onRetranslate(false) }}
                  style={tintBtn(T.fgMuted)}>새로 생성 + 다시 번역</button>
              </div>
              <div style={{ color: T.fgDim, fontSize: 11, marginTop: 6 }}>의역·호칭이 어긋나면 여기서 고치고 <b>저장</b> → "이 가이드로 다시 번역". 자막의 말투 판단이 잘못 잡혔을 때 사람이 바로잡는 곳이에요.</div>
            </div>
          )}
        </div>
      )}

      {/* 오류·경고 모아보기 — 종류별 개수 + 해당 씬 */}
      {(errorGroups.length > 0 || lowSmiIds.length > 0) && (
        <div style={{ marginBottom: 16, borderRadius: 3, overflow: 'hidden', background: T.chip, animation: 'riseIn .2s ease' }}>
          <div style={{ padding: '10px 14px', fontWeight: 700, fontSize: 13, color: T.fg }}>오류·경고 요약</div>
          <div style={{ padding: '0 14px 10px' }}>
            {errorGroups.map(g => (
              <div key={g.key} onClick={() => setFilter('error')} title="클릭하면 실패 씬만 필터"
                style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', cursor: 'pointer', borderTop: `1px solid ${T.rule}` }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: T.err, flexShrink: 0, marginTop: 6 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: T.fg }}>
                    {g.label} <span style={{ color: T.err, fontWeight: 700 }}>{g.ids.length}</span>
                    <span style={{ color: T.fgDim, fontSize: 11.5, fontWeight: 400 }}> · 씬 {g.ids.slice(0, 10).map(id => '#' + logicalNoOf[id]).join(', ')}{g.ids.length > 10 ? ` 외 ${g.ids.length - 10}` : ''}</span>
                  </div>
                  {g.hint && <div style={{ color: T.fgDim, fontSize: 11.5, marginTop: 2 }}>{g.hint}</div>}
                </div>
              </div>
            ))}
            {lowSmiIds.length > 0 && (
              <div onClick={() => setFilter('warn')} title="클릭하면 경고 씬만 필터"
                style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', cursor: 'pointer', borderTop: `1px solid ${T.rule}` }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: T.warn, flexShrink: 0, marginTop: 6 }} />
                <div style={{ flex: 1, fontSize: 13, color: T.fg }}>
                  자막 매칭 낮음 <span style={{ color: T.warn, fontWeight: 700 }}>{lowSmiIds.length}</span>
                  <span style={{ color: T.fgDim, fontSize: 11.5, fontWeight: 400 }}> · 번역이 영화 자막과 다를 수 있어요</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 완료 보고서 */}
      {isDone && (() => {
        const failed = scenes.filter(s => s.status.startsWith('error'))
        const lowSmi = scenes.filter(s => { const m = s.smiMatches; return m?.length && m.filter(x => x.aligned).length / m.length < 0.3 })
        const clean = failed.length === 0
        return (
          <div style={{ marginBottom: 16, borderRadius: 3, overflow: 'hidden', background: T.chip, animation: 'riseIn .2s ease' }}>
            <div style={{ padding: '11px 14px', color: clean ? T.accent : T.err, fontWeight: 700, fontSize: 14 }}>
              {clean ? '변환 완료 ✓' : `변환 완료 — 실패 ${failed.length}개 확인 필요`}
            </div>
            <div style={{ padding: '10px 14px', fontSize: 13, color: T.fgMuted, lineHeight: 1.8 }}>
              <div><span style={{ color: T.accent }}>· 씬 {doneCount}/{total} 완료</span>{startTime ? ` · ${fmtDuration(Date.now() - startTime)} 소요` : ''}</div>
              {ruleFmtCount > 0 && <div style={{ color: T.fgMuted }}>· 규칙포맷 {ruleFmtCount}씬 (LLM 없이 처리 — 토큰 절약)</div>}
              {totalTokens > 0 && <div>· LLM 사용 ~{fmtTokens(totalTokens)} 토큰 (추정)</div>}
              {smiPct != null && <div style={{ color: T.fgMuted }}>· 공식 자막 정렬 {smiPct}% (검토 참고 — 각본·영화 자막 차이로 낮은 건 정상)</div>}
              {failed.length > 0 && (
                <div style={{ color: T.err, marginTop: 4 }}>
                  · 실패한 씬: {failed.map(s => `#${logicalNoOf[s.id]}`).join(', ')} — 해당 씬에서 재시도하거나 실패 필터로 확인하세요
                </div>
              )}
              {lowSmi.length > 0 && (
                lowSmi.length > total * 0.5 ? (
                  // 전반적으로 안 맞음(각본≠영화 자막: 다른 언어·버전) — 씬 나열 대신 한 줄 요약
                  <div style={{ color: T.fgMuted, marginTop: 4 }}>
                    · 각본과 영화 자막 구조가 전반적으로 달라요 — 대사는 직접 번역됨 (자막 의존 낮음)
                  </div>
                ) : (
                  <div style={{ color: T.warn, marginTop: 4 }}>
                    · 자막 차이 큰 씬: {lowSmi.slice(0, 12).map(s => `#${logicalNoOf[s.id]}`).join(', ')}{lowSmi.length > 12 ? ` 외 ${lowSmi.length - 12}` : ''} — 번역이 영화 자막과 다를 수 있어요
                  </div>
                )
              )}
              {clean && lowSmi.length === 0 && <div style={{ color: T.accent }}>· 특이사항 없음</div>}
            </div>
          </div>
        )
      })()}

      {/* Download buttons */}
      {scenes.length > 0 && (() => {
        const settings = loadSettings()
        const fmtCount = scenes.filter(s => s.formatted).length
        const transCount = scenes.filter(s => s.translated).length
        const save = (type) => {
          const r = onDownload(type)  // 'saved' | 'unchanged'
          setDlMsg({ type, msg: r === 'unchanged' ? '변동 없음 (이미 저장됨)' : '저장됨 ✓' })
          setTimeout(() => setDlMsg(m => m.type === type ? { type: null, msg: '' } : m), 2000)
        }
        const dlLabel = (type, base) => dlMsg.type === type ? dlMsg.msg : base
        return (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {fmtCount > 0 && (
              <button className="sr-press" onClick={() => save('formatted')} style={dlBtn}>
                {dlLabel('formatted', `formatted.txt ${!isDone ? `(${fmtCount}씬)` : ''}`)}
              </button>
            )}
            {transCount > 0 && (
              <button className="sr-press" onClick={() => save('translated')} style={dlBtn}>
                {dlLabel('translated', `translated.txt ${!isDone ? `(${transCount}씬)` : ''}`)}
              </button>
            )}
            {settings.downloadMerged && fmtCount > 0 && transCount > 0 && (
              <button className="sr-press" onClick={() => save('merged')} style={dlBtn}>
                {dlLabel('merged', 'merged.txt')}
              </button>
            )}
          </div>
        )
      })()}

      {/* Retry all errors */}
      {errCount > 0 && phase === 'done' && (
        <button className="sr-press" onClick={() => scenes.filter(s => s.status.startsWith('error')).forEach(s => onRetry(s.id))}
          style={{ ...solidBtn(T.err), marginBottom: 12 }}>
          실패 씬 전체 재시도 ({errCount})
        </button>
      )}

      {/* Scene list */}
      <div>
        {(errCount > 0 || warnSceneCount > 0) && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {[
              { key: 'all', label: `전체 ${scenes.length}`, color: T.fgMuted },
              { key: 'warn', label: `⚠ 경고 ${warnSceneCount}`, color: T.warn },
              { key: 'error', label: `실패 ${errCount}`, color: T.err },
            ].map(f => (
              <button key={f.key} className="sr-press" onClick={() => setFilter(f.key)}
                style={{
                  padding: '5px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer', border: 'none',
                  background: filter === f.key ? f.color : T.chip,
                  color: filter === f.key ? '#fff' : T.fgDim,
                  fontWeight: filter === f.key ? 700 : 500,
                }}>{f.label}</button>
            ))}
          </div>
        )}
        {scenes.map((scene) => matchFilter(scene) && (
          <SceneCard
            key={scene.id}
            scene={scene}
            sceneNo={scene.forceSplit ? null : logicalNoOf[scene.id]}
            onRetry={onRetry}
            onReprocess={onReprocess}
            expanded={expandedId === scene.id}
            onToggle={() => setExpandedId(expandedId === scene.id ? null : scene.id)}
          />
        ))}
        {filter !== 'all' && !scenes.some(matchFilter) && (
          <div style={{ color: T.fgDim, fontSize: 13, textAlign: 'center', padding: '16px 0' }}>해당하는 씬 없음</div>
        )}
      </div>

      {/* New job button */}
      {isDone && (
        <button className="sr-press" onClick={onReset}
          style={{ ...dlBtn, width: '100%', marginTop: 16, textAlign: 'center' }}>
          + 새 작업
        </button>
      )}
    </div>
  )
}

function Badge({ children, color, title }) {
  const c = color || T.fgMuted
  // 중립 회색 칩 + 색 글씨 (색 틴트 박스 금지)
  return (
    <span title={title} style={{
      fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 999,
      background: T.chip, color: c, whiteSpace: 'nowrap',
    }}>{children}</span>
  )
}

