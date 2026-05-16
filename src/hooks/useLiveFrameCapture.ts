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
import { preprocessBiosFrameForGuide } from '../lib/cv/biosPipeline';
import type { CvFrameInput } from '../types';

interface UseLiveFrameCaptureOptions {
  canvasRef:        React.RefObject<HTMLCanvasElement>;
  videoRef:         React.RefObject<HTMLVideoElement>;
  cvReady:          boolean;
  isSendingRef:     React.MutableRefObject<boolean>;
  onFrameChange:    (base64: string, histSnapshot: any, cvSummary: string) => void;
  onQualityFeedback?: (guidanceText: string) => void;
  cooldownMs?:      number;
  histThreshold?:   number;
  minQualityScore?: number;
}

export function useLiveFrameCapture({
  canvasRef,
  videoRef,
  cvReady,
  isSendingRef,
  onFrameChange,
  onQualityFeedback,
  cooldownMs      = 2000,
  histThreshold   = BEST_PARAMS.threshold,
  minQualityScore = 30,
}: UseLiveFrameCaptureOptions) {
  const rafRef        = useRef<number>(0);
  const prevHistRef   = useRef<any>(null);
  const lastSentRef   = useRef<number>(0);
  const changeCountRef = useRef<number>(0);
  // stale guide 비교용: 응답 도착 시 LiveGuideMode에서 이 ref를 읽음
  const currentHistRef = useRef<any>(null);

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

    if (!metrics.isUsable || metrics.qualityScore < minQualityScore) {
      onQualityFeedback?.(metrics.guidanceText);
      rafRef.current = requestAnimationFrame(processFrame);
      return;
    }

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

      if (changed) {
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

          try {
            const preprocessed = preprocessBiosFrameForGuide(rgba);
            base64 = preprocessed.canvas.toDataURL('image/jpeg', 0.82).split(',')[1] ?? base64;
            cvSummary = [
              cvSummary,
              `biosRectified=${preprocessed.rectified}`,
              `biosTextRegions=${preprocessed.textRegionCount}`,
              `biosPreprocessMs=${Math.round(preprocessed.processingMs)}`,
            ].join(', ');
          } catch {
            cvSummary = `${cvSummary}, biosPreprocess=failed`;
          }

          const histSnapshot = hist.clone();   // caller(.LiveGuideMode)가 delete 책임
          onFrameChange(base64, histSnapshot, cvSummary);
        }
      } else {
        changeCountRef.current = 0;  // 변화 없는 프레임 1개라도 끼이면 리셋
      }
    }

    hist.delete();
    rafRef.current = requestAnimationFrame(processFrame);
  }, [
    cvReady, canvasRef, videoRef, isSendingRef,
    onFrameChange, onQualityFeedback,
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
