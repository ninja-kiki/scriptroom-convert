import { useState, useEffect } from 'react'
import { T, fmtDuration, fmtTokens, loadSettings } from '../lib/core.js'
import SceneCard from './SceneCard.jsx'

export default function ProcessPanel({ title, scenes, phase, startTime, isPaused, isRateLimited, onPause, onResume, onStop, onContinue, onRetry, onReprocess, onDownload, onReset, onReader, onReport }) {
  const [expandedId, setExpandedId] = useState(null)
  const [filter, setFilter] = useState('all')  // all | warn | error

  // 테마(live T) 따라가도록 컴포넌트 안에서 정의
  const ctrlBtn = {
    padding: '5px 12px', borderRadius: 3,
    background: 'none', border: `1px solid ${T.rule}`,
    color: T.fgMuted, fontSize: 12.5, cursor: 'pointer',
  }
  const dlBtn = {
    flex: 1, padding: '10px 14px', borderRadius: 3,
    background: T.chip, border: `1px solid ${T.rule}`,
    color: T.fg, fontSize: 13, cursor: 'pointer', fontWeight: 500,
  }

  const isWarnScene = (s) => {
    if (s.status.startsWith('error')) return true
    if (s.smiMatches?.length) {
      const m = s.smiMatches.filter(x => x.replaced).length
      if (m / s.smiMatches.length < 0.3) return true
    }
    return false
  }
  const matchFilter = (s) => filter === 'all' ? true : filter === 'error' ? s.status.startsWith('error') : isWarnScene(s)
  const warnSceneCount = scenes.filter(isWarnScene).length

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
    smiMatched += s.smiMatches.filter(m => m.replaced).length
  }
  const smiPct = smiAttempts > 0 ? Math.round((smiMatched / smiAttempts) * 100) : null
  const smiColor = smiPct == null ? T.fgMuted : smiPct >= 60 ? T.good : smiPct >= 35 ? T.warn : T.err

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
          <button onClick={onResume} style={{ ...ctrlBtn, color: T.warn, borderColor: T.warn, whiteSpace: 'nowrap' }}>재개</button>
        </div>
      )}
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <h2 style={{ color: T.fg, fontSize: 18, fontWeight: 700 }}>{title}</h2>
          <span style={{ color: T.fgMuted, fontSize: 13 }}>{doneCount}/{total} 씬</span>
          {phase !== 'done' && !isPaused && <span style={{ color: phase === 'formatting' ? T.fmt : T.trans, fontSize: 12, fontWeight: 600 }}>{phase === 'formatting' ? '포맷 중' : '번역 중'}</span>}
          {isPaused && <span style={{ color: T.warn, fontSize: 12 }}>일시정지됨</span>}
        </div>

        {/* Progress bar */}
        <div style={{ height: 6, background: T.rule, borderRadius: 3, marginBottom: 10, overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: 3, width: `${pct}%`,
            background: errCount > 0 ? T.err : isDone ? T.good : T.accent, transition: 'width .3s' }} />
        </div>

        {/* Stat badges */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Badge>{pct}%</Badge>
          {startTime && <Badge>{fmtDuration(Date.now() - startTime)}</Badge>}
          {totalTokens > 0 && <Badge title="LLM 입출력 추정치 (규칙·자막 직결분 제외)">~{fmtTokens(totalTokens)} 토큰</Badge>}
          {ruleFmtCount > 0 && <Badge color={T.good} title="규칙으로 포맷 — LLM 안 씀(0토큰)">규칙포맷 {ruleFmtCount}씬</Badge>}
          {smiPct != null && <Badge color={smiColor} title={`자막 일치 대사 ${smiMatched}/${smiAttempts}`}>자막매칭 {smiPct}%</Badge>}
          {errCount > 0 && <Badge color={T.err}>오류 {errCount}</Badge>}
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {phase !== 'done' && !isPaused && (
          <button onClick={onPause} style={ctrlBtn} title="잠깐 멈춤 — 재개하면 그 자리에서 이어서 계속">일시정지</button>
        )}
        {phase !== 'done' && isPaused && (
          <button onClick={onResume} style={{ ...ctrlBtn, color: T.good, borderColor: T.good }}>재개</button>
        )}
        {phase !== 'done' && (
          <button onClick={() => { if (window.confirm('작업을 중단할까요? 진행된 씬은 유지됩니다.')) onStop() }} style={{ ...ctrlBtn, color: T.err, borderColor: T.err }} title="작업 종료 — 진행된 씬은 보존, 다시 하려면 '이어하기'">중단</button>
        )}
        {hasIncomplete && (
          <button onClick={onContinue} style={{ ...ctrlBtn, color: T.accent, borderColor: T.accent }}>이어하기</button>
        )}
        {doneCount > 0 && (
          <button onClick={onReader} style={{ ...ctrlBtn, color: T.accent, borderColor: T.accent }}
            title="완료된 씬을 화살표로 넘기며 읽기 (변환 중에도 가능)">리더 모드</button>
        )}
        {onReport && (
          <button onClick={onReport} title="이 작업의 처리 정보를 로그에 기록 (문제 추적용)"
            style={{ background: 'none', border: 'none', color: T.fgDim, fontSize: 12, cursor: 'pointer', marginLeft: 'auto', textDecoration: 'underline' }}>문제 리포트</button>
        )}
      </div>

      {/* 완료 보고서 */}
      {isDone && (() => {
        const failed = scenes.filter(s => s.status.startsWith('error'))
        const lowSmi = scenes.filter(s => { const m = s.smiMatches; return m?.length && m.filter(x => x.replaced).length / m.length < 0.3 })
        const clean = failed.length === 0
        return (
          <div style={{ marginBottom: 16, borderRadius: 3, overflow: 'hidden', border: `1px solid ${clean ? T.good + '44' : T.err + '44'}`, animation: 'riseIn .2s ease' }}>
            <div style={{ padding: '11px 14px', background: (clean ? T.good : T.err) + '18', color: clean ? T.good : T.err, fontWeight: 700, fontSize: 14 }}>
              {clean ? '변환 완료 ✓' : `변환 완료 — 실패 ${failed.length}개 확인 필요`}
            </div>
            <div style={{ padding: '10px 14px', fontSize: 13, color: T.fgMuted, lineHeight: 1.8 }}>
              <div><span style={{ color: T.good }}>· 씬 {doneCount}/{total} 완료</span>{startTime ? ` · ${fmtDuration(Date.now() - startTime)} 소요` : ''}</div>
              {ruleFmtCount > 0 && <div style={{ color: T.good }}>· 규칙포맷 {ruleFmtCount}씬 (LLM 없이 처리 — 토큰 절약)</div>}
              {totalTokens > 0 && <div>· LLM 사용 ~{fmtTokens(totalTokens)} 토큰 (추정)</div>}
              {smiPct != null && <div style={{ color: smiColor }}>· 자막매칭 {smiPct}%{smiPct < 35 ? ' — 각본과 영화 자막 차이가 커요' : smiPct >= 60 ? ' — 잘 맞아요' : ''}</div>}
              {failed.length > 0 && (
                <div style={{ color: T.err, marginTop: 4 }}>
                  · 실패한 씬: {failed.map(s => `#${logicalNoOf[s.id]}`).join(', ')} — 해당 씬에서 재시도하거나 실패 필터로 확인하세요
                </div>
              )}
              {lowSmi.length > 0 && (
                <div style={{ color: T.warn, marginTop: 4 }}>
                  · 자막 차이 큰 씬: {lowSmi.slice(0, 12).map(s => `#${logicalNoOf[s.id]}`).join(', ')}{lowSmi.length > 12 ? ` 외 ${lowSmi.length - 12}` : ''} — 번역이 영화 자막과 다를 수 있어요
                </div>
              )}
              {clean && lowSmi.length === 0 && <div style={{ color: T.good }}>· 특이사항 없음</div>}
            </div>
          </div>
        )
      })()}

      {/* Download buttons */}
      {scenes.length > 0 && (() => {
        const settings = loadSettings()
        const fmtCount = scenes.filter(s => s.formatted).length
        const transCount = scenes.filter(s => s.translated).length
        return (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {fmtCount > 0 && (
              <button onClick={() => onDownload('formatted')} style={{ ...dlBtn, color: T.fmt, borderColor: T.fmt + '88' }}>
                formatted.txt {!isDone && `(${fmtCount}씬)`}
              </button>
            )}
            {transCount > 0 && (
              <button onClick={() => onDownload('translated')} style={{ ...dlBtn, color: T.trans, borderColor: T.trans + '88' }}>
                translated.txt {!isDone && `(${transCount}씬)`}
              </button>
            )}
            {settings.downloadMerged && fmtCount > 0 && transCount > 0 && (
              <button onClick={() => onDownload('merged')} style={dlBtn}>
                merged.txt
              </button>
            )}
          </div>
        )
      })()}

      {/* Retry all errors */}
      {errCount > 0 && phase === 'done' && (
        <button onClick={() => scenes.filter(s => s.status.startsWith('error')).forEach(s => onRetry(s.id))}
          style={{ ...dlBtn, background: T.err + '22', borderColor: T.err, color: T.err, marginBottom: 12 }}>
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
              <button key={f.key} onClick={() => setFilter(f.key)}
                style={{
                  padding: '4px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${filter === f.key ? f.color : T.rule}`,
                  background: filter === f.key ? f.color + '22' : 'none',
                  color: filter === f.key ? f.color : T.fgDim,
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
        <button onClick={onReset}
          style={{ ...dlBtn, width: '100%', marginTop: 16, textAlign: 'center' }}>
          + 새 작업
        </button>
      )}
    </div>
  )
}

function Badge({ children, color, title }) {
  const c = color || T.fgMuted
  return (
    <span title={title} style={{
      fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 999,
      background: c + '1e', color: c, whiteSpace: 'nowrap',
    }}>{children}</span>
  )
}

