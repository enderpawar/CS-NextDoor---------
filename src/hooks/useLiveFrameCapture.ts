/**
 * useLiveFrameCapture
 *
 * rAF 루프에서 카메라 프레임을 캡처하고
 * 모듈 3 (프레임 품질 게이트) → 모듈 2 (히스토그램 변화 감지) → 3프레임 연속 확인 순으로 처리.
 * isSendingRef = true 이면 변화가 있어도 전송 건너뜀.
 *
 * OpenCV.js Mat 수명:
 *   - prevHistRef: 교체 전 .delete() 후 .clone()
 *   - currentHistRef: 매 프레임 교체 전 .delete()
 *   - onFrameChange에 전달한 histSnapshot: 호출자(LiveGuideMode)가 .delete() 책임
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const cv: any;

import { useRef, useCallback, useEffect } from 'react';
import { analyzeFrame } from '../lib/cv/frameMetrics';
import {
  computeHistogram,
  compareHist,
  isSceneChanged,
  BEST_PARAMS,
} from '../lib/cv/changeDetection';
import { preprocessBiosFrameForGuide, runBiosPipeline } from '../lib/cv/biosPipeline';
import type { BiosTextRegion } from '../lib/cv/biosPipeline';
import type { BiosType, CvFrameInput } from '../types';

// vendor OCR 호출 제한 — 한 세션 내 최대 3회 시도, 시도 간 5초 cooldown
const VENDOR_OCR_MAX_ATTEMPTS = 3;
const VENDOR_OCR_COOLDOWN_MS  = 5000;
const DEFAULT_OVERLAY_INTERVAL_MS = 700;

/** CV Insight 패널에 전달할 라이브 메트릭 (300ms 스로틀) */
export interface CvFrameInsightMetrics {
  qualityScore: number;   // 0-100
  changeCount:  number;   // 0..windowSize (연속 변화 프레임 수)
  histScore:    number;   // 0..1 (마지막 compareHist 유사도)
}

export interface BiosArOverlay {
  corners: number[][] | null;
  textRegions: BiosTextRegion[];
  videoW: number;
  videoH: number;
  /** Canny edge map 다운샘플 썸네일 (CV 패널 미니 프리뷰). null이면 패널이 자체 placeholder 표시. */
  edgeMapDataUrl?: string | null;
}

interface UseLiveFrameCaptureOptions {
  canvasRef:         React.RefObject<HTMLCanvasElement>;
  videoRef:          React.RefObject<HTMLVideoElement>;
  cvReady:           boolean;
  isSendingRef:      React.MutableRefObject<boolean>;
  onFrameChange:     (base64: string, histSnapshot: any, cvSummary: string) => void;
  onQualityFeedback?: (guidanceText: string) => void;
  onMetricsUpdate?:  (m: CvFrameInsightMetrics) => void;
  /** AR 오버레이용: 모듈 1 Hough 모서리 + CC 텍스트 후보 + 비디오 원본 해상도 */
  onBiosOverlay?:    (overlay: BiosArOverlay) => void;
  /** Task 6: 모듈 1 OCR 결과에서 BIOS vendor를 감지했을 때 호출 */
  onBiosVendorDetected?: (vendor: BiosType) => void;
  enableBiosVendorOcr?: boolean;
  /** false면 BIOS Hough 모서리/CC 텍스트 전처리를 건너뛴다 (HW 조치 모드용). 기본 true. */
  enableBiosPreprocess?: boolean;
  /** true일 때만 화면 변화 감지를 Gemini 프레임 전송으로 연결한다. */
  enableAutoFrameSend?: boolean;
  /**
   * true면 rAF 루프 안의 OpenCV 처리(품질 분석·히스토그램·BIOS 전처리/OCR)를 건너뛴다.
   * 카메라 트랙은 살려두므로 시트/모달 해제 즉시 끊김 없이 재개됨.
   * 토글마다 rAF 재구독을 피하려고 ref로 읽는다.
   */
  paused?: boolean;
  cooldownMs?:       number;
  /** CV overlay/Canny preview 갱신 주기. Gemini 전송 cooldown과 독립. */
  overlayIntervalMs?: number;
  histThreshold?:    number;
  minQualityScore?:  number;
}

export function useLiveFrameCapture({
  canvasRef,
  videoRef,
  cvReady,
  isSendingRef,
  onFrameChange,
  onQualityFeedback,
  onMetricsUpdate,
  onBiosOverlay,
  onBiosVendorDetected,
  enableBiosVendorOcr = false,
  enableBiosPreprocess = true,
  enableAutoFrameSend = true,
  paused = false,
  cooldownMs      = 2000,
  overlayIntervalMs = DEFAULT_OVERLAY_INTERVAL_MS,
  histThreshold   = BEST_PARAMS.threshold,
  minQualityScore = 30,
}: UseLiveFrameCaptureOptions) {
  const rafRef             = useRef<number>(0);
  const prevHistRef        = useRef<any>(null);
  const lastSentRef        = useRef<number>(0);
  const changeCountRef     = useRef<number>(0);
  const lastHistScoreRef   = useRef<number>(1);        // 마지막 비교 유사도 (1=동일)
  const lastMetricsRef     = useRef<number>(0);        // 메트릭 업데이트 스로틀 타임스탬프
  // AR overlay (Hough corners + CC line regions) 업데이트 주기 — 히스토그램 변화와 무관하게
  // 일정 간격으로 처리해 사용자가 "OpenCV가 실시간으로 분석 중"임을 시각적으로 인지하게 함.
  // Gemini 전송은 별도의 cooldownMs + 3프레임 변화 조건으로 게이트되므로 비용 영향 없음.
  const lastOverlayRef     = useRef<number>(0);
  const lastPreprocessRef  = useRef<{
    rectified: boolean;
    rectificationSource: string | null;
    rectificationScore: number;
    textRegionCount: number;
    processingMs: number;
  } | null>(null);
  const lastFeedbackRef    = useRef<string | null>(null);
  const vendorOcrRunningRef = useRef(false);
  const vendorOcrAttemptsRef = useRef(0);              // 누적 OCR 시도 횟수 (성공 시 리셋)
  const vendorOcrLastTryRef = useRef(0);               // 마지막 OCR 시도 타임스탬프
  const prevVendorOcrEnabledRef = useRef(enableBiosVendorOcr);
  // stale guide 비교용: 응답 도착 시 LiveGuideMode에서 이 ref를 읽음
  const currentHistRef     = useRef<any>(null);
  // paused는 ref로 읽어서 토글마다 rAF 재구독(=prevHist 손실)을 피한다.
  const pausedRef          = useRef<boolean>(paused);
  pausedRef.current = paused;

  // enableBiosVendorOcr false → true 엣지에서 카운터 리셋
  // (컨텍스트 변경 또는 vendor 감지 해제 시 새로운 시도 세션 시작)
  if (enableBiosVendorOcr && !prevVendorOcrEnabledRef.current) {
    vendorOcrAttemptsRef.current = 0;
    vendorOcrLastTryRef.current  = 0;
  }
  prevVendorOcrEnabledRef.current = enableBiosVendorOcr;

  const emitQualityFeedback = useCallback((message: string) => {
    if (!onQualityFeedback || lastFeedbackRef.current === message) return;
    lastFeedbackRef.current = message;
    onQualityFeedback(message);
  }, [onQualityFeedback]);

  const processFrame = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas || !cvReady || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(processFrame);
      return;
    }

    // 일시정지 — GoalInputSheet 같은 풀스크린 모달 동안 OpenCV 부하 차단.
    // 비디오 트랙은 살아있고 prevHistRef도 유지되므로 해제 즉시 끊김 없이 재개.
    // 단, 일시정지 동안 화면이 바뀌었어도 새 베이스라인은 잡지 않는다.
    if (pausedRef.current) {
      changeCountRef.current = 0;
      emitQualityFeedback('');
      rafRef.current = requestAnimationFrame(processFrame);
      return;
    }

    if (video.videoWidth <= 0 || video.videoHeight <= 0) {
      rafRef.current = requestAnimationFrame(processFrame);
      return;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      rafRef.current = requestAnimationFrame(processFrame);
      return;
    }

    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // ── [모듈 3] 프레임 품질 게이트 ──────────────────────────────────────────
    const frameInput: CvFrameInput = {
      id: 'live',
      width:  canvas.width,
      height: canvas.height,
      data:   rgba.data,
    };
    const metrics = analyzeFrame(frameInput);
    const now = performance.now();

    const emitMetricsUpdate = () => {
      if (!onMetricsUpdate || now - lastMetricsRef.current <= 300) return;
      lastMetricsRef.current = now;
      onMetricsUpdate({
        qualityScore: metrics.qualityScore,
        changeCount:  Math.min(changeCountRef.current, BEST_PARAMS.windowSize),
        histScore:    lastHistScoreRef.current,
      });
    };

    if (!metrics.isUsable || metrics.qualityScore < minQualityScore) {
      // 사용자 요청: 흔들림(stabilize) 같은 경우에만 메시지 노출. 나머지는 조용히 프레임만 거부.
      emitQualityFeedback(metrics.guidance === 'stabilize' ? metrics.guidanceText : '');
      changeCountRef.current = 0;
      emitMetricsUpdate();
      rafRef.current = requestAnimationFrame(processFrame);
      return;
    }

    emitQualityFeedback('');

    // ── AR overlay 업데이트: 기본 700ms 주기 (히스토그램 변화와 독립) ───────
    // BIOS Hough 모서리 + CC 텍스트 라인 + Canny edge map을 일정 간격으로 갱신.
    // Gemini 전송은 별도 cooldown으로 게이트되므로 이 처리는 비용에 영향 없음.
    if (enableBiosPreprocess && now - lastOverlayRef.current > overlayIntervalMs) {
      lastOverlayRef.current = now;
      try {
        const preprocessed = preprocessBiosFrameForGuide(rgba);
        lastPreprocessRef.current = {
          rectified: preprocessed.rectified,
          rectificationSource: preprocessed.rectificationSource,
          rectificationScore: preprocessed.rectificationScore,
          textRegionCount: preprocessed.textRegionCount,
          processingMs: preprocessed.processingMs,
        };
        onBiosOverlay?.({
          corners: preprocessed.corners,
          textRegions: preprocessed.textRegions,
          edgeMapDataUrl: preprocessed.edgeMapDataUrl,
          videoW: canvas.width,
          videoH: canvas.height,
        });
      } catch {
        // 전처리 실패 — 다음 사이클에서 재시도. overlay는 그대로 유지.
      }
    }

    // ── [모듈 2] 히스토그램 변화 감지 ────────────────────────────────────────
    let hist: any;
    try {
      hist = computeHistogram(rgba, BEST_PARAMS.colorSpace);
    } catch {
      emitMetricsUpdate();
      rafRef.current = requestAnimationFrame(processFrame);
      return;
    }

    // currentHistRef 갱신 (stale guide 비교용)
    currentHistRef.current?.delete();
    currentHistRef.current = hist.clone();

    const cooledDown = now - lastSentRef.current > cooldownMs;
    let changedForSend = false;

    if (!prevHistRef.current) {
      prevHistRef.current = hist.clone();
    } else {
      const score   = compareHist(prevHistRef.current, hist);
      const changed = isSceneChanged(score, BEST_PARAMS.metric, histThreshold);

      // CV Insight 패널용 유사도는 Gemini 전송 cooldown과 분리해서 실제 라이브 프레임마다 갱신한다.
      lastHistScoreRef.current = score;

      if (changed) {
        changeCountRef.current++;
        changedForSend = changeCountRef.current >= BEST_PARAMS.windowSize;
        // 연속 3프레임 모두 변화하고 전송 cooldown이 끝났을 때만 다음 단계
        // (false positive — 손 떨림/Rolling Shutter 차단)
        if (changedForSend && cooledDown && !isSendingRef.current) {
          changeCountRef.current = 0;
          prevHistRef.current.delete();
          prevHistRef.current = hist.clone();
          lastSentRef.current = now;

          // ── AR 오버레이는 enableAutoFrameSend와 무관하게 항상 업데이트 ──
          //   라이브 프리뷰에서 "OpenCV가 실시간으로 처리 중"임을 시각화하기 위함.
          //   Gemini 전송만 enableAutoFrameSend로 게이트.
          let cvSummary = [
            `qualityScore=${metrics.qualityScore}`,
            `laplacianVariance=${metrics.laplacianVariance.toFixed(2)}`,
            `brightnessMean=${metrics.brightnessMean.toFixed(3)}`,
            `coverageRatio=${metrics.coverageRatio.toFixed(3)}`,
            `histMetric=${BEST_PARAMS.metric}`,
            `histColorSpace=${BEST_PARAMS.colorSpace}`,
            `histScore=${score.toFixed(4)}`,
            `histWindow=${BEST_PARAMS.windowSize}`,
          ].join(', ');

          if (enableBiosPreprocess) {
            // AR overlay 사이클(700ms)이 이미 최신 BIOS 전처리 결과를 lastPreprocessRef에 캐싱.
            // 히스토그램 변화 시점에서 추가 호출하지 않고 캐시 값을 cvSummary에 그대로 첨부.
            const cached = lastPreprocessRef.current;
            if (cached) {
              cvSummary = [
                cvSummary,
                `biosRectified=${cached.rectified}`,
                `biosRectSource=${cached.rectificationSource ?? 'none'}`,
                `biosRectScore=${cached.rectificationScore.toFixed(2)}`,
                `biosTextRegions=${cached.textRegionCount}`,
                `biosPreprocessMs=${Math.round(cached.processingMs)}`,
              ].join(', ');
            } else {
              cvSummary = `${cvSummary}, biosPreprocess=pending`;
            }
          } else {
            cvSummary = `${cvSummary}, biosPreprocess=skipped`;
          }

          // vendor OCR: enableAutoFrameSend 무관하게 시도 — 라이브 프리뷰에서도 vendor 자동 감지가 동작해야 함.
          //   시도 횟수(최대 3회) + cooldown(5초) 제한으로 모바일 배터리/메모리 부담 차단.
          const ocrCooledDown = now - vendorOcrLastTryRef.current > VENDOR_OCR_COOLDOWN_MS;
          const ocrUnderLimit = vendorOcrAttemptsRef.current < VENDOR_OCR_MAX_ATTEMPTS;
          if (
            enableBiosVendorOcr
            && onBiosVendorDetected
            && !vendorOcrRunningRef.current
            && ocrUnderLimit
            && ocrCooledDown
          ) {
            vendorOcrRunningRef.current = true;
            vendorOcrAttemptsRef.current++;
            vendorOcrLastTryRef.current  = now;
            const ocrFrame = new ImageData(
              new Uint8ClampedArray(rgba.data),
              rgba.width,
              rgba.height,
            );
            void runBiosPipeline(ocrFrame)
              .then(result => {
                if (result.detectedVendor) {
                  onBiosVendorDetected(result.detectedVendor);
                }
              })
              .catch(() => {
                // OCR 실패는 라이브 가이드 흐름을 막지 않음
              })
              .finally(() => {
                vendorOcrRunningRef.current = false;
              });
          }

          // ── Gemini 전송: enableAutoFrameSend가 true일 때만 ──
          if (enableAutoFrameSend) {
            const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1] ?? '';
            const histSnapshot = hist.clone();   // caller(.LiveGuideMode)가 delete 책임
            onFrameChange(base64, histSnapshot, cvSummary);
          }
        }
      } else {
        changeCountRef.current = 0;  // 변화 없는 프레임 1개라도 끼이면 리셋
      }
    }

    // ── CV Insight 메트릭 스로틀 업데이트 (300ms) ──────────────────────────────
    emitMetricsUpdate();

    hist.delete();
    rafRef.current = requestAnimationFrame(processFrame);
  }, [
    cvReady, canvasRef, videoRef, isSendingRef,
    onFrameChange, emitQualityFeedback, onMetricsUpdate, onBiosOverlay,
    onBiosVendorDetected, enableBiosVendorOcr, enableBiosPreprocess, enableAutoFrameSend,
    cooldownMs, overlayIntervalMs, histThreshold, minQualityScore,
  ]);

  useEffect(() => {
    if (!cvReady) return;
    rafRef.current = requestAnimationFrame(processFrame);
    return () => {
      cancelAnimationFrame(rafRef.current);
      prevHistRef.current?.delete();
      prevHistRef.current = null;
      currentHistRef.current?.delete();
      currentHistRef.current = null;
      lastPreprocessRef.current = null;
      lastOverlayRef.current = 0;
    };
  }, [cvReady, processFrame]);

  return { currentHistRef };
}
