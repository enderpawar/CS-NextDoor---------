import '../../styles/mobile.css';
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Eye, Loader2, ListChecks, MessageCircleQuestion } from 'lucide-react';
import type { CaptureState } from '../../hooks/useGeminiLiveGuide';

interface Props {
  text:         string;
  isStreaming:  boolean;
  captureState: CaptureState;
  elapsed:      number;
  staleGuide:   boolean;
  compact?:      boolean;
  targeting?:    boolean;
}

export default function GuideBubble({
  text,
  isStreaming,
  captureState,
  elapsed,
  staleGuide,
  compact = false,
  targeting = false,
}: Props) {
  const shouldDefaultExpand = !compact && !targeting;
  const [expanded, setExpanded] = useState(shouldDefaultExpand);
  const sections = splitGuideText(text);
  const animationKey = isStreaming ? 'streaming' : text;
  const primaryLine = sections.actions[0] ?? sections.observation ?? '현재 화면을 분석해 다음 단계를 안내할게요.';
  // 타깃 조작 중에는 OCR 콜아웃을 우선 보여주기 위해 스트리밍 중에도 칩 높이를 유지한다.
  const shouldCollapse = targeting ? (!expanded || isStreaming) : (!isStreaming && !expanded);

  // 새 응답 도착 또는 compact/targeting 모드 변경 시 기본 상태로 복원.
  useEffect(() => {
    setExpanded(!compact && !targeting);
  }, [compact, targeting, text]);

  return (
    <div className={`nd-guide-stack${targeting ? ' is-targeting' : ''}`}>
      {/* 3단계 피드백 UI */}
      {captureState !== 'idle' && (
        <div className="nd-live-guide-feedback-row">
          {captureState === 'captured' && (
            <span className="nd-capture-badge">
              <CheckCircle2 size={14} aria-hidden="true" />
              캡처됨
            </span>
          )}
          {captureState === 'analyzing' && (
            <div className="nd-analyzing-bar">
              <Loader2 size={14} aria-hidden="true" className="nd-spin-icon" />
              <span>분석 중 {elapsed}초</span>
              {elapsed >= 3 && elapsed < 7 && (
                <span className="nd-analyzing-sub">잠시만요!</span>
              )}
              {elapsed >= 7 && (
                <span className="nd-analyzing-sub">거의 다 됐어요</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 안내 버블 */}
      <div key={animationKey} className={`nd-guide-bubble${isStreaming ? ' streaming' : ''}${shouldCollapse ? ' compact' : ''}${targeting ? ' targeting' : ''}`}>
        <div className="nd-guide-bubble-head">
          <div>
            <div className="nd-guide-bubble-label">다음 할 일</div>
            <div className="nd-guide-bubble-title">
              {isStreaming ? '화면을 분석하고 있어요' : primaryLine}
            </div>
          </div>
          <div className="nd-guide-head-actions">
            {!(targeting && shouldCollapse) && (
              <span className={`nd-guide-status-pill${isStreaming ? ' active' : ''}`}>
                {isStreaming ? '확인 중' : '준비됨'}
              </span>
            )}
            {!isStreaming && (
              <button
                type="button"
                className="nd-guide-toggle-btn"
                onClick={() => setExpanded(prev => !prev)}
                aria-label={expanded ? '안내 접기' : '안내 펼치기'}
                aria-expanded={expanded}
              >
                {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
                <span>{expanded ? '접기' : '펼치기'}</span>
              </button>
            )}
          </div>
        </div>

        {!shouldCollapse && (
        <div className="nd-guide-sections">
          {sections.observation && (
            <section className="nd-guide-section">
              <div className="nd-guide-section-icon" aria-hidden="true">
                <Eye size={15} />
              </div>
              <div className="nd-guide-section-body">
                <p className="nd-guide-section-label">현재 상태</p>
                <p className="nd-guide-section-text">{sections.observation}</p>
              </div>
            </section>
          )}

          {sections.actions.length > 0 && (
            <section className="nd-guide-section prominent">
              <div className="nd-guide-section-icon" aria-hidden="true">
                <ListChecks size={15} />
              </div>
              <div className="nd-guide-section-body">
                <p className="nd-guide-section-label">해볼 일</p>
                <ol className="nd-guide-action-list">
                  {sections.actions.map((action, index) => (
                    <li key={`${action}-${index}`}>{action}</li>
                  ))}
                </ol>
              </div>
            </section>
          )}

          {sections.question && (
            <section className="nd-guide-section question">
              <div className="nd-guide-section-icon" aria-hidden="true">
                <MessageCircleQuestion size={15} />
              </div>
              <div className="nd-guide-section-body">
                <p className="nd-guide-section-label">확인</p>
                <p className="nd-guide-section-text">{sections.question}</p>
              </div>
            </section>
          )}
        </div>
        )}

        {isStreaming && <span className="nd-guide-cursor" aria-hidden="true" />}
      </div>

      {/* stale guide 경고 */}
      {staleGuide && (
        <div className="nd-stale-warning" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          화면이 바뀐 것 같아요. 현재 화면을 다시 비춰주세요.
        </div>
      )}
    </div>
  );
}

function splitGuideText(text: string) {
  const parts = text
    .split(/\n+/)
    .map(part => part.replace(/\*\*/g, '').trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return { observation: '', actions: [], question: '' };
  }

  const last = parts[parts.length - 1] ?? '';
  const hasQuestion = /[?？]|나요|셨나요|인가요|해주세요$/.test(last);
  const question = hasQuestion && parts.length > 1 ? last : '';
  const body = question ? parts.slice(0, -1) : parts;
  const observation = body[0] ?? '';
  const actions = body.slice(1);

  if (!observation && actions.length === 0 && text.trim()) {
    return { observation: text.trim(), actions: [], question: '' };
  }

  return { observation, actions, question };
}
