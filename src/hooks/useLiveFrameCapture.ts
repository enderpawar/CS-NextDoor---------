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
  cooldownMs?:       number;
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
  cooldownMs      = 2000,
  histThreshold   = BEST_PARAMS.threshold,
  minQualityScore = 30,
}: UseLiveFrameCaptureOptions) {
  const rafRef             = useRef<number>(0);
  const prevHistRef        = useRef<any>(null);
  const lastSentRef        = useRef<number>(0);
  const changeCountRef     = useRef<number>(0);
  const lastHistScoreRef   = useRef<number>(1);        // 마지막 비교 유사도 (1=동일)
  const lastMetricsRef     = useRef<number>(0);        // 메트릭 업데이트 스로틀 타임스탬프
  const lastFeedbackRef    = useRef<string | null>(null);
  const vendorOcrRunningRef = useRef(false);
  const vendorOcrAttemptsRef = useRef(0);              // 누적 OCR 시도 횟수 (성공 시 리셋)
  const vendorOcrLastTryRef = useRef(0);               // 마지막 OCR 시도 타임스탬프
  const prevVendorOcrEnabledRef = useRef(enableBiosVendorOcr);
  // stale guide 비교용: 응답 도착 시 LiveGuideMode에서 이 ref를 읽음
  const currentHistRef     = useRef<any>(null);

  // enableBiosVendorOcr false → true 엣지에서 카운터 리셋
  // (컨텍스트 변경 또는 vendor 감지 해제 시 새로운 시도 세션 시작)
  if (enableBiosVendorOcr && !prevVendorOcrEnabledRef.current) {
    vendorOcrAttemptsRef.current = 0;
    vendorOcrLastTryRef.current  = 0;
  }
  prevVendorOcrEnabledRef.current = enableBiosVendorOcr;

  const processFrame = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas || !cvReady || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(processFrame);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      rafRef.current = requestAnimationFrame(processFrame);
      return;
    }

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
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

    const emitQualityFeedback = (message: string) => {
      if (!onQualityFeedback || lastFeedbackRef.current === message) return;
      lastFeedbackRef.current = message;
      onQualityFeedback(message);
    };

    if (!metrics.isUsable || metrics.qualityScore < minQualityScore) {
      // 사용자 요청: 흔들림(stabilize) 같은 경우에만 메시지 노출. 나머지는 조용히 프레임만 거부.
      emitQualityFeedback(metrics.guidance === 'stabilize' ? metrics.guidanceText : '');
      rafRef.current = requestAnimationFrame(processFrame);
      return;
    }

    emitQualityFeedback('');

    // ── [모듈 2] 히스토그램 변화 감지 ────────────────────────────────────────
    let hist: any;
    try {
      hist = computeHistogram(rgba, BEST_PARAMS.colorSpace);
    } catch {
      rafRef.current = requestAnimationFrame(processFrame);
      return;
    }

    // currentHistRef 갱신 (stale guide 비교용)
    currentHistRef.current?.delete();
    currentHistRef.current = hist.clone();

    const now       = performance.now();
    const cooledDown = now - lastSentRef.current > cooldownMs;

    if (!prevHistRef.current) {
      prevHistRef.current = hist.clone();
    } else if (cooledDown && !isSendingRef.current) {
      const score   = compareHist(prevHistRef.current, hist);
      const changed = isSceneChanged(score, BEST_PARAMS.metric, histThreshold);

      lastHistScoreRef.current = score;  // 메트릭 패널용 저장

      if (changed && enableAutoFrameSend) {
        changeCountRef.current++;
        // 연속 3프레임 모두 변화 시에만 전송 (false positive — 손 떨림/Rolling Shutter 차단)
        if (changeCountRef.current >= BEST_PARAMS.windowSize) {
          changeCountRef.current = 0;
          prevHistRef.current.delete();
          prevHistRef.current = hist.clone();
          lastSentRef.current = now;

          let base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1] ?? '';
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
            try {
              const preprocessed = preprocessBiosFrameForGuide(rgba);
              cvSummary = [
                cvSummary,
                `biosRectified=${preprocessed.rectified}`,
                `biosTextRegions=${preprocessed.textRegionCount}`,
                `biosPreprocessMs=${Math.round(preprocessed.processingMs)}`,
              ].join(', ');
              onBiosOverlay?.({
                corners: preprocessed.corners,
                textRegions: preprocessed.textRegions,
                videoW: canvas.width,
                videoH: canvas.height,
              });
            } catch {
              cvSummary = `${cvSummary}, biosPreprocess=failed`;
              onBiosOverlay?.({
                corners: null,
                textRegions: [],
                videoW: canvas.width,
                videoH: canvas.height,
              });
            }
          } else {
            cvSummary = `${cvSummary}, biosPreprocess=skipped`;
          }

          // vendor OCR: 시도 횟수(최대 3회) + cooldown(5초) 제한
          // — Tesseract.js는 모바일에서 1~3초 소요, 무제한 재시도 시 배터리/메모리 부담
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

          const histSnapshot = hist.clone();   // caller(.LiveGuideMode)가 delete 책임
          onFrameChange(base64, histSnapshot, cvSummary);
        }
      } else {
        changeCountRef.current = 0;  // 변화 없는 프레임 1개라도 끼이면 리셋
      }
    }

    // ── CV Insight 메트릭 스로틀 업데이트 (300ms) ──────────────────────────────
    if (onMetricsUpdate && now - lastMetricsRef.current > 300) {
      lastMetricsRef.current = now;
      onMetricsUpdate({
        qualityScore: metrics.qualityScore,
        changeCount:  changeCountRef.current,
        histScore:    lastHistScoreRef.current,
      });
    }

    hist.delete();
    rafRef.current = requestAnimationFrame(processFrame);
  }, [
    cvReady, canvasRef, videoRef, isSendingRef,
    onFrameChange, onQualityFeedback, onMetricsUpdate, onBiosOverlay,
    onBiosVendorDetected, enableBiosVendorOcr, enableAutoFrameSend,
    cooldownMs, histThreshold, minQualityScore,
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
    };
  }, [cvReady, processFrame]);

  return { currentHistRef };
}
