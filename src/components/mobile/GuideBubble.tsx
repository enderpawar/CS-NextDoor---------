import '../../styles/mobile.css';
import type { CaptureState } from '../../hooks/useGeminiLiveGuide';

interface Props {
  text:         string;
  isStreaming:  boolean;
  captureState: CaptureState;
  elapsed:      number;
  staleGuide:   boolean;
}

export default function GuideBubble({
  text,
  isStreaming,
  captureState,
  elapsed,
  staleGuide,
}: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {/* 3단계 피드백 UI */}
      {captureState !== 'idle' && (
        <div className="nd-live-guide-feedback-row">
          {captureState === 'captured' && (
            <span className="nd-capture-badge">📸 캡처됨</span>
          )}
          {captureState === 'analyzing' && (
            <div className="nd-analyzing-bar">
              <span>⏳ 분석 중 {elapsed}초</span>
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
      <div className={`nd-guide-bubble${isStreaming ? ' streaming' : ''}`}>
        <div className="nd-guide-bubble-label">AI 안내</div>
        <span>
          {text}
          {isStreaming && <span className="nd-guide-cursor" aria-hidden="true" />}
        </span>
      </div>

      {/* stale guide 경고 */}
      {staleGuide && (
        <div className="nd-stale-warning" role="alert">
          ⚠️ 화면이 바뀐 것 같아요. 현재 화면을 다시 비춰주세요.
        </div>
      )}
    </div>
  );
}
