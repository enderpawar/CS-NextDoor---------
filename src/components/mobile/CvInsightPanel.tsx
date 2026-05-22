/**
 * CvInsightPanel — CV 알고리즘 라이브 시각화 패널
 *
 * ux-redesign.md Task 3 — CV depth 어필 핵심.
 * 카메라 뷰 우상단에 오버레이로 표시.
 * 클래식 OpenCV 파이프라인이 매 프레임 실행 중임을 평가자/사용자에게 노출.
 */

import type { CvFrameInsightMetrics } from '../../hooks/useLiveFrameCapture';
import '../../styles/mobile.css';

const WINDOW_SIZE = 3;  // BEST_PARAMS.windowSize — 연속 3프레임 기준

interface BiosInsight {
  rectified:    boolean;
  textRegions:  number;
  processMs:    number;
}

interface Props {
  metrics:      CvFrameInsightMetrics | null;
  bios:         BiosInsight | null;
  cvReady:      boolean;
  /** Canny edge map 다운샘플 썸네일 data URL. null이면 placeholder 표시. */
  edgeMapDataUrl?: string | null;
}

function QualityBar({ score }: { score: number }) {
  const color = score >= 70 ? '#22c55e' : score >= 40 ? '#f59e0b' : '#ef4444';
  return (
    <div className="nd-cv-quality-bar-track">
      <div
        className="nd-cv-quality-bar-fill"
        style={{ width: `${score}%`, background: color }}
      />
    </div>
  );
}

export default function CvInsightPanel({ metrics, bios, cvReady, edgeMapDataUrl }: Props) {
  const textStatus = bios
    ? bios.textRegions >= 8 ? '충분' : bios.textRegions > 0 ? '부족' : '없음'
    : '--';

  return (
    <div className="nd-cv-panel" role="status" aria-label="CV 처리 상태">
      <div className="nd-cv-panel-header">
        <span className="nd-cv-panel-title">CV PIPELINE</span>
        <span className={`nd-cv-panel-dot${cvReady ? ' active' : ''}`} />
      </div>

      {!cvReady ? (
        <p className="nd-cv-panel-loading">OpenCV 로딩 중…</p>
      ) : (
        <div className="nd-cv-panel-rows">

          {/* 품질 스코어 */}
          <div className="nd-cv-panel-row">
            <span className="nd-cv-panel-label">⚡ 품질</span>
            <span className="nd-cv-panel-val">
              {metrics ? metrics.qualityScore : '--'}
            </span>
          </div>
          {metrics && <QualityBar score={metrics.qualityScore} />}

          {/* 히스토그램 유사도 */}
          <div className="nd-cv-panel-row">
            <span className="nd-cv-panel-label">📊 유사도</span>
            <span className="nd-cv-panel-val">
              {metrics ? metrics.histScore.toFixed(3) : '--'}
            </span>
          </div>

          {/* 연속 변화 감지 */}
          <div className="nd-cv-panel-row">
            <span className="nd-cv-panel-label">🎯 변화</span>
            <span className="nd-cv-panel-val">
              {metrics
                ? `${metrics.changeCount} / ${WINDOW_SIZE}`
                : `- / ${WINDOW_SIZE}`}
            </span>
          </div>

          {/* 구분선 */}
          <div className="nd-cv-panel-divider" />

          {/* BIOS 화면 정면화 (모듈 1) */}
          <div className="nd-cv-panel-row">
            <span className="nd-cv-panel-label">📐 BIOS</span>
            <span className={`nd-cv-panel-val${bios?.rectified ? ' nd-cv-ok' : ''}`}>
              {bios ? (bios.rectified ? '정면화 ✓' : '탐색중') : '--'}
            </span>
          </div>

          {/* 텍스트 영역 수 (모듈 1 CC) */}
          <div className="nd-cv-panel-row">
            <span className="nd-cv-panel-label">📝 텍스트</span>
            <span className="nd-cv-panel-val">
              {bios ? `${bios.textRegions}개 · ${textStatus}` : '--'}
            </span>
          </div>

          {/* 파이프라인 처리 시간 */}
          {bios && bios.processMs > 0 && (
            <div className="nd-cv-panel-row">
              <span className="nd-cv-panel-label">⏱ 처리</span>
              <span className="nd-cv-panel-val">{bios.processMs}ms</span>
            </div>
          )}

          {/* Canny edge 미니 프리뷰 — OpenCV가 매 변화 감지마다 실제로 처리하고 있다는 시각 증거. */}
          <div className="nd-cv-edge-preview">
            <span className="nd-cv-edge-preview-label">Canny edges</span>
            <div className="nd-cv-edge-preview-frame">
              {edgeMapDataUrl ? (
                <img
                  className="nd-cv-edge-preview-img"
                  src={edgeMapDataUrl}
                  alt=""
                  aria-hidden="true"
                />
              ) : (
                <span className="nd-cv-edge-preview-empty">대기 중</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
