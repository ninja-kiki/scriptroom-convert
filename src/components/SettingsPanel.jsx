import { useState } from 'react'
import { T, loadGuidelines, saveGuidelines, loadSettings, saveSettings, DEFAULT_FORMAT_GUIDELINES, DEFAULT_TRANSLATE_GUIDELINES, MODELS, ACCENTS, accentForVersion } from '../lib/core.js'
import { APP_VERSION, VERSION_LABEL, CHANGELOG } from '../lib/version.js'


export default function SettingsPanel({ onClose, themeName = 'light', onToggleTheme, accentKey = 'auto', onAccent }) {
  const [s, setS] = useState(() => loadSettings())
  const [formatText, setFormatText] = useState(() => loadGuidelines('format'))
  const [translateText, setTranslateText] = useState(() => loadGuidelines('translate'))
  const [formatOpen, setFormatOpen] = useState(false)
  const [translateOpen, setTranslateOpen] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showChangelog, setShowChangelog] = useState(false)

  const taStyle = {
    width: '100%', minHeight: 200, resize: 'vertical',
    background: T.bgInput, border: `1px solid ${T.rule}`,
    borderRadius: 3, color: T.fg, fontSize: 13,
    padding: 14, fontFamily: 'monospace', lineHeight: 1.6, outline: 'none',
  }

  function patch(p) { setS(prev => ({ ...prev, ...p })) }

  function handleSave() {
    saveSettings(s)
    saveGuidelines('format', formatText)
    saveGuidelines('translate', translateText)
    setSaved(true)
    setTimeout(() => { setSaved(false); onClose() }, 800)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000b', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 100, animation: 'fadeIn .15s ease' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 600, background: T.bgCard,
        borderRadius: '16px 16px 0 0', maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        animation: 'slideUp .24s cubic-bezier(.2,.8,.2,1)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 20px 14px', borderBottom: `1px solid ${T.rule}` }}>
          <span style={{ color: T.fg, fontWeight: 700, fontSize: 17 }}>설정</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.fgMuted, fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>

          {/* 테마 */}
          <div style={{ borderTop: `1px solid ${T.rule}` }}>
            <Row label="테마" desc="라이트 / 다크">
              <div style={{ display: 'flex', gap: 6 }}>
                {[{ id: 'light', label: '라이트' }, { id: 'dark', label: '다크' }].map(t => (
                  <button key={t.id} onClick={() => { if (themeName !== t.id) onToggleTheme?.() }} style={{
                    padding: '7px 14px', borderRadius: 3, border: 'none',
                    background: themeName === t.id ? T.accent : T.chip,
                    color: themeName === t.id ? T.accentFg : T.fgMuted,
                    fontWeight: 700, fontSize: 13, cursor: 'pointer',
                  }}>{t.label}</button>
                ))}
              </div>
            </Row>
            <Row label="액센트 색상" desc={`자동 = 버전마다 빨·파·노 회전 (현재 v${APP_VERSION}) · 버튼·탭에만 적용`} last>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button onClick={() => onAccent?.('auto')} style={{
                  padding: '7px 12px', borderRadius: 3, border: 'none',
                  background: accentKey === 'auto' ? T.accent : T.chip,
                  color: accentKey === 'auto' ? T.accentFg : T.fgMuted,
                  fontWeight: 700, fontSize: 13, cursor: 'pointer',
                }}>자동</button>
                {['red', 'blue', 'yellow'].map(k => {
                  const on = accentKey === k
                  const isAutoPick = accentKey === 'auto' && accentForVersion() === k
                  return (
                    <button key={k} onClick={() => onAccent?.(k)} title={ACCENTS[k].label} style={{
                      width: 26, height: 26, borderRadius: '50%', cursor: 'pointer', padding: 0,
                      background: ACCENTS[k].accent,
                      border: (isAutoPick && !on) ? `2px dashed ${T.fgDim}` : '2px solid transparent',
                      // 선택: 틈 있는 부드러운 회색 링 (검정 테두리 대신)
                      boxShadow: on ? `0 0 0 2px ${T.bgCard}, 0 0 0 3.5px ${T.fgDim}` : `0 0 0 1px ${T.rule}`,
                    }} />
                  )
                })}
              </div>
            </Row>
          </div>

          {/* 처리 */}
          <div style={{ borderTop: `1px solid ${T.rule}`, borderBottom: `1px solid ${T.rule}` }}>
            <Row label="동시 처리 씬 수" desc="높을수록 빠름, 오류 가능성 증가">
              <div style={{ display: 'flex', gap: 6 }}>
                {[2, 3, 4, 5].map(n => (
                  <button key={n} onClick={() => patch({ concurrency: n })} style={{
                    width: 38, height: 34, borderRadius: 3, border: 'none',
                    background: s.concurrency === n ? T.accent : T.chip,
                    color: s.concurrency === n ? T.accentFg : T.fgMuted,
                    fontWeight: 700, fontSize: 14, cursor: 'pointer',
                  }}>{n}</button>
                ))}
              </div>
            </Row>
            <Row label="포맷 모델" desc="구조 파악 — 보통 규칙으로 처리, 폴백 때만 사용">
              <ModelPicker value={s.formatModel || s.model} onChange={m => patch({ formatModel: m })} />
            </Row>
            <Row label="번역 모델" desc="품질 중요하면 Sonnet 이상">
              <ModelPicker value={s.translateModel || s.model} onChange={m => patch({ translateModel: m })} />
            </Row>
            <Row label="짧은 씬 배칭" desc="짧은 씬 여러 개를 한 번에 — 호출수·비용 절감">
              <Toggle on={s.batchShort !== false} onClick={() => patch({ batchShort: s.batchShort === false })} />
            </Row>
            <Row label="진단 후 자동 번역" desc="작품 개선 시 진단 끝나면 묻지 않고 바로 번역 (끄면 예상시간 보고 직접 시작)" last>
              <Toggle on={!!s.reprocAutoGo} onClick={() => patch({ reprocAutoGo: !s.reprocAutoGo })} />
            </Row>
          </div>

          {/* 포맷 지침 (기본 닫힘) */}
          <Collapsible label="포맷 지침" open={formatOpen} onToggle={() => setFormatOpen(v => !v)}>
            <textarea value={formatText} onChange={e => setFormatText(e.target.value)} style={taStyle} />
            <ResetBtn onClick={() => { if (window.confirm('포맷 지침을 기본값으로 되돌릴까요?')) setFormatText(DEFAULT_FORMAT_GUIDELINES) }} />
          </Collapsible>

          {/* 번역 지침 (기본 닫힘) */}
          <Collapsible label="번역 지침" open={translateOpen} onToggle={() => setTranslateOpen(v => !v)}>
            <textarea value={translateText} onChange={e => setTranslateText(e.target.value)} style={taStyle} />
            <ResetBtn onClick={() => { if (window.confirm('번역 지침을 기본값으로 되돌릴까요?')) setTranslateText(DEFAULT_TRANSLATE_GUIDELINES) }} />
          </Collapsible>

          {/* 앱 정보 — 버전 누르면 변경 이력 */}
          <div style={{ padding: '14px 20px 18px', textAlign: 'center', color: T.fgDim, fontSize: 11 }}>
            scriptroom convert ·{' '}
            <button onClick={() => setShowChangelog(true)} className="sr-press"
              style={{ background: 'none', border: 'none', color: T.accent, fontSize: 11, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
              v{APP_VERSION}
            </button>
          </div>

        </div>

        {showChangelog && (
          <div onClick={() => setShowChangelog(false)}
            style={{ position: 'absolute', inset: 0, background: '#000a', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 10, animation: 'fadeIn .15s ease' }}>
            <div onClick={e => e.stopPropagation()}
              style={{ width: '100%', maxWidth: 460, maxHeight: '80vh', overflowY: 'auto', background: T.bgCard, borderRadius: 4, border: `1px solid ${T.rule}`, padding: '18px 20px', animation: 'popIn .18s ease' }}>
              {/* 앱 아이콘 헤더 (파비콘과 동일 — 3색 바) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginBottom: 16 }}>
                <svg width="54" height="54" viewBox="0 0 512 512" style={{ flexShrink: 0, borderRadius: 13, boxShadow: '0 2px 10px rgba(0,0,0,0.14)' }} aria-hidden>
                  <rect width="512" height="512" rx="112" fill="#f3efe6" />
                  <rect x="120" y="136" width="64" height="240" fill="#D62A1E" />
                  <rect x="224" y="136" width="64" height="240" fill="#F2B705" />
                  <rect x="328" y="136" width="64" height="240" fill="#1C4E8A" />
                </svg>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: T.fg, fontWeight: 700, fontSize: 16, letterSpacing: '-.2px' }}>scriptroom convert</div>
                  <div style={{ color: T.fgMuted, fontSize: 12.5, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>v{APP_VERSION} · {VERSION_LABEL}</div>
                </div>
                <button onClick={() => setShowChangelog(false)} style={{ background: 'none', border: 'none', color: T.fgMuted, fontSize: 22, cursor: 'pointer', lineHeight: 1, alignSelf: 'flex-start' }}>×</button>
              </div>
              <div style={{ color: T.fgDim, fontSize: 11, fontWeight: 700, letterSpacing: '.06em', marginBottom: 10 }}>바뀐 점</div>
              {CHANGELOG.map((v, i) => (
                <div key={v.version} style={{ marginBottom: i < CHANGELOG.length - 1 ? 18 : 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                    <span style={{ color: T.accent, fontWeight: 700, fontSize: 14 }}>v{v.version}</span>
                    <span style={{ color: T.fgMuted, fontSize: 12.5 }}>{v.label}</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, color: T.fgMuted, fontSize: 13, lineHeight: 1.65 }}>
                    {v.notes.map((n, k) => <li key={k} style={{ marginBottom: 3 }}>{n}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ padding: '12px 20px', borderTop: `1px solid ${T.rule}` }}>
          <button onClick={handleSave} style={{
            width: '100%', padding: '13px', borderRadius: 3, border: 'none',
            background: saved ? T.good : T.accent,
            color: T.accentFg, fontWeight: 700, fontSize: 15, cursor: 'pointer',
          }}>{saved ? '저장됨 ✓' : '저장'}</button>
        </div>
      </div>
    </div>
  )
}

function SectionLabel({ children, collapsible, expanded, onToggle }) {
  return (
    <div onClick={collapsible ? onToggle : undefined} style={{
      padding: '14px 20px 6px', display: 'flex', justifyContent: 'space-between',
      cursor: collapsible ? 'pointer' : 'default',
    }}>
      <span style={{ color: T.fgMuted, fontSize: 12, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase' }}>{children}</span>
      {collapsible && <span style={{ color: T.fgDim, fontSize: 12 }}>{expanded ? '▲' : '▼'}</span>}
    </div>
  )
}

function ModelPicker({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {MODELS.map(m => {
        const on = value === m.id
        return (
          <button key={m.id} onClick={() => onChange(m.id)}
            title={m.label}
            style={{
              padding: '6px 9px', borderRadius: 3, border: 'none',
              background: on ? T.accent : T.chip, color: on ? T.accentFg : T.fgMuted,
              fontWeight: 700, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
            }}>{m.label.split(' ')[0]}</button>
        )
      })}
    </div>
  )
}

function Row({ label, desc, children, last }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '13px 20px',
      borderBottom: last ? 'none' : `1px solid ${T.rule}`,
    }}>
      <div style={{ flex: 1, marginRight: 12 }}>
        <div style={{ color: T.fg, fontSize: 15 }}>{label}</div>
        {desc && <div style={{ color: T.fgDim, fontSize: 12, marginTop: 2 }}>{desc}</div>}
      </div>
      {children}
    </div>
  )
}

function Collapsible({ label, open, onToggle, children }) {
  return (
    <div style={{ borderBottom: `1px solid ${T.rule}` }}>
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', cursor: 'pointer' }}>
        <span style={{ color: T.fgMuted, fontSize: 13, fontWeight: 600 }}>{label}</span>
        <span style={{ color: T.fgDim, fontSize: 12, transition: 'transform .15s', transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
      </div>
      {open && <div style={{ padding: '0 20px 16px', animation: 'riseIn .18s ease' }}>{children}</div>}
    </div>
  )
}

function Toggle({ on, onClick }) {
  return (
    <button onClick={onClick} style={{
      width: 46, height: 26, borderRadius: 999, border: 'none', cursor: 'pointer',
      background: on ? T.accent : T.chip, position: 'relative', transition: 'background .15s', flexShrink: 0,
    }}>
      <span style={{
        position: 'absolute', top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: '50%',
        background: on ? T.accentFg : T.fgDim, transition: 'left .15s',
      }} />
    </button>
  )
}

function Checkmark({ on }) {
  return (
    <div style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: on ? T.accent : 'none', border: `2px solid ${on ? T.accent : T.fgDim}` }}>
      {on && <span style={{ color: T.accentFg, fontSize: 13, fontWeight: 700 }}>✓</span>}
    </div>
  )
}

function ResetBtn({ onClick }) {
  return <button onClick={onClick} style={{ background: 'none', border: 'none', color: T.fgDim, fontSize: 13, cursor: 'pointer', padding: '6px 0', display: 'block', marginTop: 4 }}>기본값으로 리셋</button>
}

