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
import { API_BASE_URL } from '../api/config';

const MAX_HISTORY  = 6;   // 최대 N턴 슬라이딩 히스토리 (토큰 누적 방지)
const SESSION_TTL  = 15 * 60 * 1000;   // 15분 (ms)

// 백엔드 없이 데모 동작을 위한 모의 모드
// VITE_USE_MOCK=true 또는 개발환경 + 백엔드 미응답 시 자동 전환
const MOCK_RESPONSES: Record<string, string> = {
  BIOS_ENTRY:      '📺 화면이 감지됐어요!\n\nPC 전원을 켠 직후 제조사 로고가 보이면, 그 순간 **Del** 또는 **F2** 키를 빠르게 눌러주세요.\n\nASUS는 Del, GIGABYTE는 Del, MSI는 Del/F2, HP는 F10이 많아요.',
  BOOT_MENU:       '📺 부팅 화면이에요!\n\n**F8, F11, F12** 중 하나를 눌러보세요. 제조사마다 다르지만 대부분 F11 또는 F12예요.\n\n부팅 메뉴가 열리면 설치 USB를 선택하세요.',
  WINDOWS_INSTALL: '📺 화면을 확인했어요!\n\nUSB가 연결돼 있고 부팅 순서가 USB 우선으로 설정돼 있으면 Windows 설치 화면이 바로 나와요.\n\n"지금 설치" 버튼을 누르고 지침을 따라주세요.',
  BIOS_RESET:      '📺 BIOS 화면이에요!\n\n**F9** 키(또는 "Load Optimized Defaults" 메뉴)를 찾아 누르세요.\n\n확인 창이 뜨면 Yes를 선택하고 F10으로 저장 후 재시작하세요.',
  SECURE_BOOT:     '📺 BIOS가 보여요!\n\n**Boot** 탭 → **Secure Boot** 항목으로 이동하세요.\n\n`Enabled`를 `Disabled`로 변경하고 F10으로 저장하면 돼요.',
  NO_BOOT:         '📺 화면을 확인했어요!\n\n전원 LED가 켜지지만 화면이 안 나오면, RAM을 뺐다가 다시 꽂아보세요. 꽂는 소리가 날 때까지요.\n\n그래도 안 되면 GPU(그래픽카드) 연결 상태를 확인해주세요.',
  SLOW_PC:         '📺 화면이에요!\n\n작업 관리자(Ctrl+Shift+Esc)를 열어 CPU/메모리 사용률이 90% 이상인 프로세스를 찾아보세요.\n\n특정 앱이 원인이면 종료하거나 시작프로그램에서 제거할 수 있어요.',
  APP_NOT_OPENING: '📺 오류 화면이 보여요!\n\n오류 코드나 메시지를 알려주시면 정확한 원인을 찾을 수 있어요.\n\n일단 해당 프로그램을 **제어판 → 프로그램 제거**에서 지운 뒤 재설치해보세요.',
  NETWORK_ISSUE:   '📺 네트워크 상태 화면이에요!\n\nWi-Fi 아이콘에 느낌표가 있으면 IP 충돌이나 DNS 문제일 수 있어요.\n\n`ipconfig /flushdns` 명령을 관리자 CMD에서 실행해보세요.',
  BLUE_SCREEN:     '📺 블루스크린이에요!\n\n중지 코드가 보이시나요? 코드를 알려주시면 정확한 원인을 찾을게요.\n\n`MEMORY_MANAGEMENT`면 RAM 문제, `DRIVER_IRQL`이면 드라이버 문제일 가능성이 높아요.',
};

async function mockStream(text: string, onChunk: (chunk: string) => void): Promise<void> {
  const words = text.split('');
  for (const ch of words) {
    onChunk(ch);
    await new Promise(r => setTimeout(r, 18 + Math.random() * 22));
  }
}

export type CaptureState = 'idle' | 'captured' | 'analyzing';

export function useGeminiLiveGuide() {
  const [session,       setSession]       = useState<GuideSession | null>(null);
  const [streamText,    setStreamText]    = useState('');
  const [isStreaming,   setIsStreaming]   = useState(false);
  const [captureState,  setCaptureState]  = useState<CaptureState>('idle');
  const [elapsed,       setElapsed]       = useState(0);
  const [staleGuide,    setStaleGuide]    = useState(false);

  const isSendingRef      = useRef(false);
  const abortRef          = useRef<AbortController | null>(null);
  const historyRef        = useRef<GuideMessage[]>([]);
  const elapsedTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 클라이언트 최소 전송 간격 — 서버 도달 전 차단 (useLiveFrameCapture cooldown 보다 우선)
  const lastSendAtRef     = useRef<number>(0);
  // 429 지수 백오프: 횟수마다 대기 시간 2배 증가 (30→60→120→240→300s)
  const rateLimitUntilRef  = useRef<number>(0);
  const rateLimitCountRef  = useRef<number>(0);   // 연속 429 횟수

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
    if (sid && !sid.startsWith('mock-')) {
      fetch(`${API_BASE_URL}/api/guide/${sid}`, { method: 'DELETE' }).catch(() => {});
    }
    setSession(s => (s ? { ...s, status: 'DONE' } : null));
    historyRef.current = [];
    // streamText는 지우지 않음 — done 페이지에서 마지막 응답 텍스트 유지
    // (다음 startSession에서 초기화됨)
    isSendingRef.current = false;
    stopElapsedTimer();
    setCaptureState('idle');
    setStaleGuide(false);
  }, [session, stopElapsedTimer]);

  // ── 세션 시작 ───────────────────────────────────────────────────────────────
  const startSession = useCallback(async (context: GuideContext): Promise<void> => {
    let sessionId: string;

    try {
      const res = await fetch(`${API_BASE_URL}/api/guide/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context }),
      });
      if (!res.ok) throw new Error('API 오류');
      const data: { sessionId: string } = await res.json();
      sessionId = data.sessionId;
    } catch {
      // 백엔드 미응답 → mock 모드로 자동 전환 (데모/개발 환경)
      sessionId = `mock-${Date.now()}`;
    }

    setSession({ sessionId, context, status: 'ACTIVE' });
    historyRef.current = [];
    setStreamText('');
    setStaleGuide(false);

    // 15분 후 자동 종료
    sessionTimerRef.current = setTimeout(() => endSession(), SESSION_TTL);
  }, [endSession]);

  // ── 프레임 전송 + SSE 스트리밍 ─────────────────────────────────────────────
  const sendFrame = useCallback(
    async (base64: string, histSnapshot: any, cvSummary?: string): Promise<void> => {
      if (!session || isSendingRef.current) {
        histSnapshot?.delete();
        return;
      }

      const now = Date.now();

      // 클라이언트 최소 전송 간격 (3초) — 서버 도달 전 선제 차단
      const MIN_INTERVAL = 3_000;
      if (now - lastSendAtRef.current < MIN_INTERVAL) {
        histSnapshot?.delete();
        return;
      }

      // 429 쿨다운 중이면 차단
      if (now < rateLimitUntilRef.current) {
        const waitSec = Math.ceil((rateLimitUntilRef.current - now) / 1000);
        setStreamText(`요청이 너무 많아요. ${waitSec}초 후 다시 시도해주세요.`);
        histSnapshot?.delete();
        return;
      }

      lastSendAtRef.current  = now;
      isSendingRef.current   = true;
      abortRef.current = new AbortController();

      // 3단계 피드백 UI — Step 1: 캡처됨
      setCaptureState('captured');
      setTimeout(() => {
        setCaptureState('analyzing');
        setElapsed(0);
        elapsedTimerRef.current = setInterval(
          () => setElapsed(e => e + 1),
          1000,
        );
      }, 500);

      setIsStreaming(true);
      setStreamText('');
      let accumulated = '';      // [완료] 감지용 원문
      let displayed   = '';      // 화면 표시용 ([완료] 태그 제거)

      try {
        // mock 세션이면 MOCK_RESPONSES 스트리밍 시뮬레이션
        if (session.sessionId.startsWith('mock-')) {
          await new Promise(r => setTimeout(r, 800));   // 네트워크 지연 모사
          const mockText = MOCK_RESPONSES[session.context] ?? '화면이 감지됐어요! 더 자세히 보여주시면 구체적인 안내를 드릴게요.';
          await mockStream(mockText, chunk => {
            accumulated += chunk;
            displayed   += chunk;
            setStreamText(displayed);
          });
        } else {
          const response = await fetch(
            `${API_BASE_URL}/api/guide/${session.sessionId}/frame`,
            {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                frameBase64: base64,
                history: historyRef.current.slice(-MAX_HISTORY),
                cvSummary,
              }),
              signal: abortRef.current.signal,
            },
          );

          if (response.status === 429) {
            // 지수 백오프: 30→60→120→240→300s (max)
            rateLimitCountRef.current++;
            const headerSec = parseInt(response.headers.get('Retry-After') ?? '0', 10);
            const backoffSec = headerSec > 0
              ? headerSec
              : Math.min(30 * Math.pow(2, rateLimitCountRef.current - 1), 300);
            rateLimitUntilRef.current = Date.now() + backoffSec * 1000;
            console.warn(`[guide] 429 (${rateLimitCountRef.current}번째) → ${backoffSec}s 대기`);
            setStreamText(`요청이 너무 많아요. ${backoffSec}초 후 다시 시도할 수 있어요.`);
            return;
          }
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
                // 누적 버퍼 기준 [완료] 감지 — 청크 분할 무관
                if (accumulated.includes('[완료]')) endSession();
                return;
              }
              accumulated += data;
              // [완료] 태그는 세션 종료 신호이므로 화면에 표시하지 않음
              const clean = data.replace(/\[완료\]/g, '');
              if (clean) {
                displayed += clean;
                setStreamText(displayed);
              }
            }
          }
        }

        // 성공 응답 → 백오프 카운터 리셋
        rateLimitCountRef.current = 0;

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
