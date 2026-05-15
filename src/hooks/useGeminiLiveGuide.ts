/**
 * useGeminiLiveGuide
 *
 * 가이드 세션 생명주기 관리 + Gemini SSE 스트리밍 수신.
 *
 * 설계 원칙:
 *   - EventSource(GET 전용) 대신 fetch() + ReadableStream으로 POST 본문 전송
 *   - isSendingRef: 이전 응답 완료 전 새 프레임 전송 차단
 *   - AbortController: 언마운트/endSession 시 진행 중 스트림 즉시 취소
 *   - [완료] 태그: 청크 분할 대응 → accumulated 버퍼 기준으로 판단
 *   - histSnapshot: 전달받은 OpenCV Mat — finally에서 반드시 .delete()
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { GuideContext, GuideSession, GuideMessage } from '../types';

const API_BASE     = 'http://localhost:8080';
const MAX_HISTORY  = 6;   // 최대 N턴 슬라이딩 히스토리 (토큰 누적 방지)
const SESSION_TTL  = 15 * 60 * 1000;   // 15분 (ms)

export type CaptureState = 'idle' | 'captured' | 'analyzing';

export function useGeminiLiveGuide() {
  const [session,       setSession]       = useState<GuideSession | null>(null);
  const [streamText,    setStreamText]    = useState('');
  const [isStreaming,   setIsStreaming]   = useState(false);
  const [captureState,  setCaptureState]  = useState<CaptureState>('idle');
  const [elapsed,       setElapsed]       = useState(0);
  const [staleGuide,    setStaleGuide]    = useState(false);

  const isSendingRef     = useRef(false);
  const abortRef         = useRef<AbortController | null>(null);
  const historyRef       = useRef<GuideMessage[]>([]);
  const elapsedTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── 내부 헬퍼: 경과 타이머 정지 ────────────────────────────────────────────
  const stopElapsedTimer = useCallback(() => {
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    setElapsed(0);
  }, []);

  // ── 세션 종료 ───────────────────────────────────────────────────────────────
  const endSession = useCallback(() => {
    abortRef.current?.abort();
    if (sessionTimerRef.current) clearTimeout(sessionTimerRef.current);
    const sid = session?.sessionId;
    if (sid) {
      fetch(`${API_BASE}/api/guide/${sid}`, { method: 'DELETE' }).catch(() => {});
    }
    setSession(s => (s ? { ...s, status: 'DONE' } : null));
    historyRef.current = [];
    setStreamText('');
    isSendingRef.current = false;
    stopElapsedTimer();
    setCaptureState('idle');
    setStaleGuide(false);
  }, [session, stopElapsedTimer]);

  // ── 세션 시작 ───────────────────────────────────────────────────────────────
  const startSession = useCallback(async (context: GuideContext): Promise<void> => {
    const res = await fetch(`${API_BASE}/api/guide/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context }),
    });
    if (!res.ok) throw new Error('가이드 세션 시작 실패');
    const data: { sessionId: string } = await res.json();

    setSession({ sessionId: data.sessionId, context, status: 'ACTIVE' });
    historyRef.current = [];
    setStreamText('');
    setStaleGuide(false);

    // 15분 후 자동 종료
    sessionTimerRef.current = setTimeout(() => endSession(), SESSION_TTL);
  }, [endSession]);

  // ── 프레임 전송 + SSE 스트리밍 ─────────────────────────────────────────────
  const sendFrame = useCallback(
    async (base64: string, histSnapshot: any): Promise<void> => {
      if (!session || isSendingRef.current) {
        histSnapshot?.delete();
        return;
      }

      isSendingRef.current = true;
      abortRef.current = new AbortController();

      // 3단계 피드백 UI — Step 1: 캡처됨
      setCaptureState('captured');
      setTimeout(() => {
        // Step 2: 분석 중 + 경과 타이머 시작
        setCaptureState('analyzing');
        setElapsed(0);
        elapsedTimerRef.current = setInterval(
          () => setElapsed(e => e + 1),
          1000,
        );
      }, 500);

      setIsStreaming(true);
      setStreamText('');
      let accumulated = '';

      try {
        const response = await fetch(
          `${API_BASE}/api/guide/${session.sessionId}/frame`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              frameBase64: base64,
              history: historyRef.current.slice(-MAX_HISTORY),
            }),
            signal: abortRef.current.signal,
          },
        );

        if (!response.ok || !response.body) throw new Error('스트리밍 응답 실패');

        const reader  = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') {
              // 청크 분할 무관 — 누적 버퍼 기준 [완료] 판단
              if (accumulated.includes('[완료]')) {
                endSession();
              }
              return;
            }
            accumulated += data;
            setStreamText(accumulated);
          }
        }

        // 히스토리 슬라이딩 업데이트
        historyRef.current = [
          ...historyRef.current,
          { role: 'user' as const,  text: '[frame]' },
          { role: 'model' as const, text: accumulated },
        ].slice(-MAX_HISTORY * 2);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setStreamText('오류가 발생했어요. 잠시 후 다시 시도해주세요.');
        }
      } finally {
        isSendingRef.current  = false;
        setIsStreaming(false);
        setCaptureState('idle');
        stopElapsedTimer();
        abortRef.current = null;
        histSnapshot?.delete();  // OpenCV Mat 해제
      }
    },
    [session, endSession, stopElapsedTimer],
  );

  // ── 언마운트 시 세션 정리 ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (sessionTimerRef.current) clearTimeout(sessionTimerRef.current);
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, []);

  return {
    session,
    streamText,
    isStreaming,
    captureState,
    elapsed,
    staleGuide,
    setStaleGuide,
    isSendingRef,
    historyRef,
    startSession,
    endSession,
    sendFrame,
  };
}
