/**
 * LiveGuideMode — Phase 7-B 메인 쇼케이스
 *
 * CV 모듈 통합 흐름:
 *   카메라 → [모듈 3] 품질 게이트 → [모듈 2] 변화 감지(3프레임) → [모듈 1] BIOS 파이프라인 → Gemini Vision
 *
 * 핵심 설계:
 *   - 세션 시작 즉시 STATIC_FIRST_GUIDE 표시 (Gemini 응답 전 공백 방지)
 *   - stale guide: 응답 도착 시 capturedHist vs currentHist 비교 → 유사도 < 0.7 경고
 *   - iOS: 페이지 이동 금지 (카메라 권한 만료 방지) — 모달/오버레이로만 UI 처리
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const cv: any;

import { useState, useRef, useCallback, useEffect } from 'react';
import '../../styles/mobile.css';
import { useOpenCV }            from '../../hooks/useOpenCV';
import { useGeminiLiveGuide }   from '../../hooks/useGeminiLiveGuide';
import { useLiveFrameCapture }  from '../../hooks/useLiveFrameCapture';
import GuideContextSelector     from './GuideContextSelector';
import GuideBubble              from './GuideBubble';
import ShootingGuide            from './ShootingGuide';
import type { GuideContext }     from '../../types';
import { compareHist }          from '../../lib/cv/changeDetection';

// 세션 시작 즉시 표시할 컨텍스트별 정적 안내 (Gemini 응답 전 공백 방지)
const STATIC_FIRST_GUIDE: Record<GuideContext, string> = {
  BIOS_ENTRY:       'PC 재시작 후 제조사 로고가 뜨면 Del 또는 F2 키를 빠르게 눌러주세요.',
  BOOT_MENU:        '재시작 후 F8, F11, F12 중 하나를 눌러보세요 (제조사마다 다름).',
  WINDOWS_INSTALL:  'USB가 연결됐는지 확인 후 카메라를 화면에 비춰주세요.',
  BIOS_RESET:       'BIOS 진입 후 F9 (Load Defaults) 또는 Setup Defaults 항목을 찾아주세요.',
  SECURE_BOOT:      'BIOS 진입 후 Boot 또는 Security 탭으로 이동해주세요.',
};

type PageState = 'select' | 'guide-intro' | 'camera' | 'done';

export default function LiveGuideMode() {
  const [page,          setPage]         = useState<PageState>('select');
  const [context,       setContext]      = useState<GuideContext | null>(null);
  const [qualityText,   setQualityText]  = useState('');
  const [streamError,   setStreamError]  = useState('');

  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const capturedHistRef = useRef<any>(null);

  const { cvReady } = useOpenCV();

  const guide = useGeminiLiveGuide();

  // ── 프레임 변화 감지 후 전송 ────────────────────────────────────────────────
  const handleFrameChange = useCallback(
    async (base64: string, histSnapshot: any, cvSummary: string) => {
      capturedHistRef.current?.delete();
      capturedHistRef.current = histSnapshot?.clone?.() ?? null;

      try {
        await guide.sendFrame(base64, histSnapshot, cvSummary);
      } catch {
        // sendFrame 내부에서 이미 처리됨
      }
    },
    [guide],
  );

  const { currentHistRef } = useLiveFrameCapture({
    canvasRef,
    videoRef,
    cvReady,
    isSendingRef: guide.isSendingRef,
    onFrameChange: handleFrameChange,
    onQualityFeedback: setQualityText,
  });

  // ── stale guide 감지: isStreaming false 전환 시 ────────────────────────────
  useEffect(() => {
    if (guide.isStreaming) return;
    if (!capturedHistRef.current || !currentHistRef.current || !cvReady) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const score: number = compareHist(capturedHistRef.current, currentHistRef.current);
      guide.setStaleGuide(score < 0.7);
    } catch {
      // cv 아직 초기화 전일 수 있음
    }

    capturedHistRef.current.delete();
    capturedHistRef.current = null;
  }, [guide.isStreaming, cvReady, guide, currentHistRef]);

  // ── 카메라 시작 ─────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch {
      setStreamError('카메라 권한이 필요해요. 브라우저 설정에서 허용해주세요.');
    }
  }, []);

  const stopCamera = useCallback(() => {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach(t => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // ── 컨텍스트 선택 → 촬영 안내 → 카메라 시작 ─────────────────────────────
  const handleContextSelect = useCallback((ctx: GuideContext) => {
    setContext(ctx);
    setPage('guide-intro');
  }, []);

  const handleGuideStart = useCallback(async () => {
    if (!context) return;
    setPage('camera');
    startCamera();
    try {
      await guide.startSession(context);
    } catch {
      setStreamError('가이드 세션 시작에 실패했어요. 잠시 후 다시 시도해주세요.');
    }
  }, [context, guide, startCamera]);

  const handleEnd = useCallback(() => {
    guide.endSession();
    stopCamera();
    setPage('done');
    setQualityText('');
    setStreamError('');
    capturedHistRef.current?.delete();
    capturedHistRef.current = null;
  }, [guide, stopCamera]);

  // ── 언마운트 시 정리 ────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopCamera();
      capturedHistRef.current?.delete();
      capturedHistRef.current = null;
    };
  }, [stopCamera]);

  // ── 세션 DONE 전환 감지 ──────────────────────────────────────────────────────
  useEffect(() => {
    if (guide.session?.status === 'DONE') {
      stopCamera();
      setPage('done');
    }
  }, [guide.session?.status, stopCamera]);

  // ── 렌더 ────────────────────────────────────────────────────────────────────

  if (page === 'select') {
    return (
      <div className="nd-live-guide-page">
        <div className="nd-live-guide-topbar">
          <span className="nd-live-guide-title">라이브 카메라 가이드</span>
        </div>
        <GuideContextSelector onSelect={handleContextSelect} />
        {!cvReady && (
          <p style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', textAlign: 'center' }}>
            OpenCV.js 로딩 중… 잠시만 기다려주세요.
          </p>
        )}
      </div>
    );
  }

  if (page === 'guide-intro' && context) {
    return (
      <div className="nd-live-guide-page">
        <div className="nd-live-guide-topbar">
          <span className="nd-live-guide-title">촬영 준비</span>
          <span className="nd-live-guide-context-badge">{context}</span>
        </div>
        <ShootingGuide onDismiss={handleGuideStart} />
      </div>
    );
  }

  if (page === 'camera' && context) {
    const displayText = guide.streamText || STATIC_FIRST_GUIDE[context];

    return (
      <div className="nd-live-guide-page">
        {/* 상단 바 */}
        <div className="nd-live-guide-topbar">
          <span className="nd-live-guide-title">라이브 가이드</span>
          <span className="nd-live-guide-context-badge">{context.replace('_', ' ')}</span>
          <button type="button" className="nd-live-guide-end-btn" onClick={handleEnd}>
            종료
          </button>
        </div>

        {/* 카메라 뷰 */}
        <div className="nd-camera-wrapper">
          <video
            ref={videoRef}
            className="nd-camera-video"
            autoPlay
            playsInline
            muted
          />
          {/* OpenCV 처리용 숨김 canvas */}
          <canvas
            ref={canvasRef}
            className="nd-camera-canvas"
            style={{ display: 'none' }}
          />
          {streamError && (
            <div className="nd-camera-overlay">{streamError}</div>
          )}
        </div>

        {/* 품질 피드백 */}
        {qualityText && (
          <div className="nd-quality-feedback">{qualityText}</div>
        )}

        {/* AI 안내 버블 */}
        <GuideBubble
          text={displayText}
          isStreaming={guide.isStreaming}
          captureState={guide.captureState}
          elapsed={guide.elapsed}
          staleGuide={guide.staleGuide}
        />
      </div>
    );
  }

  // done
  return (
    <div className="nd-live-guide-page" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', padding: '2rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>✅</div>
        <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--color-heading)' }}>
          가이드가 완료됐어요!
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', marginTop: '0.5rem' }}>
          작업이 완료됐어요. 문제가 해결되지 않았다면 다시 시도해주세요.
        </p>
        <button
          type="button"
          onClick={() => { setPage('select'); setContext(null); guide.endSession?.(); }}
          style={{
            marginTop: '1.5rem',
            padding: '0.65rem 2rem',
            background: 'linear-gradient(135deg, #5a81fa, #446ce4)',
            color: '#fff',
            border: 'none',
            borderRadius: '12px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          처음으로
        </button>
      </div>
    </div>
  );
}
