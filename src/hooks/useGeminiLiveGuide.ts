/**
 * useGeminiLiveGuide
 *
 * 가이드 세션 생명주기 관리 + Gemini SSE 스트리밍 수신.
 *
 * 설계 원칙:
 *   - EventSource(GET 전용) 대신 fetch() + ReadableStream으로 POST 본문 전송
 *   - isSendingRef: 이전 응답 완료 전 새 프레임 전송 차단
 *   - AbortController: 언마운트/endSession 시 진행 중 스트림 즉시 취소
 *   - 세션 완료는 사용자 명시 액션으로만 처리. 모델 응답 태그로 자동 종료하지 않음.
 *   - histSnapshot: 전달받은 OpenCV Mat — finally에서 반드시 .delete()
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { GuideArTarget, GuideContext, GuideOcrRegion, GuideSession, GuideMessage } from '../types';
import { API_BASE_URL } from '../api/config';

const MAX_HISTORY  = 6;   // 최대 N턴 슬라이딩 히스토리 (토큰 누적 방지)
// 백엔드 없이 데모 동작을 위한 모의 모드
// VITE_USE_MOCK=true 또는 개발환경 + 백엔드 미응답 시 자동 전환
const MOCK_RESPONSES: Record<string, string> = {
  GENERAL:         '📺 화면을 먼저 확인할게요.\n\nPC 화면이나 본체 상태가 보이도록 비춰주세요. 로고, 오류 문구, 전원 LED, 팬 동작 중 눈에 보이는 단서를 기준으로 문제 유형을 먼저 나눠볼게요.\n\n현재 화면에 글자나 불빛이 보이나요?',
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

const MOCK_FOLLOW_UP_RESPONSES: Record<string, string> = {
  GENERAL:         '화면 단서가 아직 부족하면 먼저 범위를 좁혀볼게요.\n\n전원 버튼을 눌렀을 때 본체 LED, 팬 소리, 모니터 메시지 중 무엇이 보이거나 들리는지 하나씩 확인해주세요.\n\nLED나 팬 반응이 있나요?',
  NO_BOOT:         '이전 조치로 해결되지 않았다면 다음은 케이블과 입력 소스 확인이에요.\n\n모니터 전원 LED가 켜져 있는지 보고, HDMI/DP 케이블을 뺐다가 다시 꽂은 뒤 모니터 입력이 현재 케이블 포트로 맞는지 확인해주세요.\n\n확인 후 화면이 나오나요?',
  SLOW_PC:         '이전 조치 후에도 느리다면 시작 프로그램을 줄여볼게요.\n\n작업 관리자 → 시작프로그램 탭에서 영향도가 높은 항목을 하나씩 사용 안 함으로 바꾼 뒤 재부팅해주세요.\n\n재부팅 후에도 같은 증상이 있나요?',
  APP_NOT_OPENING: '재설치로도 해결되지 않았다면 권한이나 런타임 문제를 확인할 차례예요.\n\n앱을 우클릭해서 관리자 권한으로 실행해보고, 같은 오류 문구가 반복되는지 확인해주세요.\n\n오류가 그대로 나오나요?',
  NETWORK_ISSUE:   'DNS 초기화 후에도 안 된다면 연결 경로를 분리해서 볼게요.\n\n휴대폰 핫스팟에 연결했을 때 인터넷이 되는지 확인해주세요. 핫스팟은 되고 집 Wi-Fi만 안 되면 공유기 쪽 문제일 가능성이 큽니다.\n\n핫스팟에서는 연결되나요?',
  BLUE_SCREEN:     '같은 블루스크린이 반복된다면 최근 변경 사항부터 되돌려볼게요.\n\n최근 설치한 드라이버나 프로그램이 있다면 안전 모드에서 제거한 뒤 재부팅해주세요.\n\n제거 후에도 블루스크린이 나오나요?',
  BIOS_BOOT:       '이전 BIOS 조치로 해결되지 않았다면 부팅 장치 인식부터 확인할게요.\n\nBIOS의 Boot 메뉴에서 SSD나 USB가 목록에 보이는지 확인해주세요. 목록에 없다면 저장장치 연결이나 USB 제작 상태를 먼저 봐야 합니다.\n\n부팅 장치가 목록에 보이나요?',
};

const MOCK_QUESTION_RESPONSES: Record<string, string> = {
  GENERAL:         '질문하신 내용은 현재 화면 단서와 함께 볼게요.\n\n화면에 보이는 오류 문구나 장치 상태를 기준으로 원인을 좁히면 됩니다. 지금 가장 눈에 띄는 문구나 불빛이 무엇인지 한 번 더 확인해주세요.',
  NO_BOOT:         '질문 기준으로 보면 먼저 화면 출력과 부팅 진행 여부를 나눠야 해요.\n\n모니터에 입력 없음 메시지만 보이면 케이블/입력 소스부터, 제조사 로고에서 멈추면 부팅 장치나 BIOS 설정부터 확인하는 게 좋아요.',
  SLOW_PC:         '지금 질문은 성능 병목을 찾는 흐름으로 보면 됩니다.\n\n작업 관리자에서 CPU, 메모리, 디스크 중 90% 이상인 항목이 있는지 먼저 확인해주세요. 그 항목이 원인 후보입니다.',
  APP_NOT_OPENING: '질문하신 증상은 오류 문구가 핵심 단서예요.\n\n같은 앱을 관리자 권한으로 실행했을 때도 같은 메시지가 나오는지 보고, 오류 코드가 있으면 그 코드를 기준으로 다음 조치를 정하면 됩니다.',
  NETWORK_ISSUE:   '네트워크 질문은 연결 범위를 먼저 분리해서 보면 쉬워요.\n\n휴대폰 핫스팟에서는 되는지 확인해보세요. 핫스팟은 되고 현재 Wi-Fi만 안 되면 공유기나 DNS 쪽 가능성이 큽니다.',
  BLUE_SCREEN:     '블루스크린 질문은 중지 코드가 가장 중요해요.\n\n화면에 보이는 stop code를 기준으로 RAM, 드라이버, 저장장치 문제를 나눌 수 있습니다. 코드가 보이면 그대로 알려주세요.',
  BIOS_BOOT:       '질문하신 BIOS 화면은 현재 선택해야 할 메뉴를 화면 글자 기준으로 찾으면 됩니다.\n\nBoot, Save, Secure Boot, USB 같은 항목이 보이는지 확인하고, 표시된 위치가 있으면 그 항목부터 조작해주세요.',
};

async function mockStream(text: string, onChunk: (chunk: string) => void): Promise<void> {
  const words = text.split('');
  for (const ch of words) {
    onChunk(ch);
    await new Promise(r => setTimeout(r, 18 + Math.random() * 22));
  }
}

function parseArTarget(raw: string): GuideArTarget | null {
  if (!raw || raw === 'null') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<GuideArTarget>;
    if (!parsed.targetId || !parsed.label) return null;
    return {
      targetId: parsed.targetId,
      label: parsed.label,
      reason: parsed.reason,
    };
  } catch {
    return null;
  }
}

function pickMockTarget(
  regions: GuideOcrRegion[] | undefined,
  context: GuideContext,
): GuideArTarget | null {
  if (!regions?.length || context !== 'BIOS_BOOT') return null;
  const preferred = [
    /boot/i,
    /secure/i,
    /save/i,
    /install/i,
    /usb/i,
  ];
  const target = preferred
    .map(pattern => regions.find(region => pattern.test(region.text)))
    .find(Boolean) ?? regions[0];
  if (!target) return null;
  return {
    targetId: target.id,
    label: '여기를 선택',
    reason: 'OCR 후보 중 현재 BIOS 조작과 가장 관련 있어 보여요.',
  };
}

export type CaptureState = 'idle' | 'captured' | 'analyzing';

export function useGeminiLiveGuide() {
  const [session,       setSession]       = useState<GuideSession | null>(null);
  const [streamText,    setStreamText]    = useState('');
  const [isStreaming,   setIsStreaming]   = useState(false);
  const [captureState,  setCaptureState]  = useState<CaptureState>('idle');
  const [elapsed,       setElapsed]       = useState(0);
  const [staleGuide,    setStaleGuide]    = useState(false);
  const [arTarget,      setArTarget]      = useState<GuideArTarget | null>(null);

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
    setArTarget(null);
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
    setArTarget(null);

  }, [endSession]);

  // ── 프레임 전송 + SSE 스트리밍 ─────────────────────────────────────────────
  const sendFrame = useCallback(
    async (
      base64: string,
      histSnapshot: any,
      cvSummary?: string,
      ocrRegions?: GuideOcrRegion[],
      userQuestion?: string,
      taskGoal?: string,
    ): Promise<void> => {
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
      setArTarget(null);
      let accumulated = '';      // 히스토리 저장용 원문
      let displayed   = '';      // 화면 표시용

      try {
        // mock 세션이면 MOCK_RESPONSES 스트리밍 시뮬레이션
        if (session.sessionId.startsWith('mock-')) {
          await new Promise(r => setTimeout(r, 800));   // 네트워크 지연 모사
          const isFollowUp = cvSummary?.includes('guidePhase=followup');
          const mockText = userQuestion?.trim()
            ? (MOCK_QUESTION_RESPONSES[session.context] ?? `질문하신 내용("${userQuestion.trim()}")을 현재 화면 기준으로 볼게요.\n\n화면에 보이는 단서와 이전 안내를 함께 보면, 먼저 가장 눈에 띄는 오류 문구나 선택 항목을 확인하는 게 좋습니다.`)
            : isFollowUp
            ? (MOCK_FOLLOW_UP_RESPONSES[session.context] ?? '이전 조치로 해결되지 않았으니 다음 단계를 볼게요. 화면에서 바뀐 부분을 기준으로 다른 원인을 하나씩 확인해주세요. 확인 후 증상이 해결되셨나요?')
            : (MOCK_RESPONSES[session.context] ?? '화면이 감지됐어요! 더 자세히 보여주시면 구체적인 안내를 드릴게요.');
          await mockStream(mockText, chunk => {
            accumulated += chunk;
            displayed   += chunk;
            setStreamText(displayed);
          });
          const mockTarget = pickMockTarget(ocrRegions, session.context);
          if (mockTarget) setArTarget(mockTarget);
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
                ocrRegions: ocrRegions?.slice(0, 80) ?? [],
                userQuestion: userQuestion?.trim() || undefined,
                taskGoal: taskGoal?.trim() || undefined,
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
          let buffer = '';
          let doneSignal = false;

          const handleSseEvent = (rawEvent: string) => {
            const lines = rawEvent
              .replace(/\r/g, '')
              .split('\n')
              .filter(line => line.length > 0);
            let eventName = 'message';
            const dataLines: string[] = [];

            for (const line of lines) {
              if (line.startsWith('event:')) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).replace(/^ /, ''));
              }
            }

            const data = dataLines.join('\n');
            if (!data) return;
            if (data === '[DONE]') {
              doneSignal = true;
              return;
            }

            if (eventName === 'overlay') {
              const parsed = parseArTarget(data);
              setArTarget(parsed);
              return;
            }

            accumulated += data;
            const clean = data.replace(/\[완료\]/g, '');
            if (clean) {
              displayed += clean;
              setStreamText(displayed);
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
            let separator = buffer.indexOf('\n\n');
            while (separator >= 0) {
              const rawEvent = buffer.slice(0, separator);
              buffer = buffer.slice(separator + 2);
              handleSseEvent(rawEvent);
              if (doneSignal) break;
              separator = buffer.indexOf('\n\n');
            }
            if (doneSignal) break;
          }

          if (buffer.trim()) handleSseEvent(buffer);
        }

        // 성공 응답 → 백오프 카운터 리셋
        rateLimitCountRef.current = 0;

        // 히스토리 슬라이딩 업데이트
        historyRef.current = [
          ...historyRef.current,
          { role: 'user' as const,  text: userQuestion?.trim() || (taskGoal?.trim() ? `[frame for goal] ${taskGoal.trim()}` : '[frame]') },
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
    arTarget,
    setStaleGuide,
    setArTarget,
    isSendingRef,
    historyRef,
    startSession,
    endSession,
    sendFrame,
  };
}
