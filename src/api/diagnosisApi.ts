// API 호출 레이어 — 백엔드 /api/diagnosis/* 엔드포인트 래핑
// Electron 환경에서는 file:// 프로토콜이므로 절대 URL 필수

import type {
  HypothesesResponse,
  SoftwareDiagnosisRequest,
  SoftwareDiagnosisResponse,
  PatternsResponse,
} from '../types';
import type { EventLog } from '../types/electron';
import { API_BASE_URL, USE_MOCK_API } from './config';

// ── Mock (백엔드 미실행 시 개발용) ───────────────────────────────────────────
// VITE_USE_MOCK=true일 때만 활성화
export const USE_MOCK = USE_MOCK_API;

const MOCK_DELAY = 1400; // ms — 실제 API 응답 느낌을 주기 위한 딜레이

function mockDelay<T>(value: T): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(value), MOCK_DELAY));
}

const MOCK_HYPOTHESES: HypothesesResponse = {
  diagnosisId: 'mock-diag-001',
  immediateAction: '팬 소음·발열이 심하다면 PC 내부 먼지 청소와 서멀 컴파운드 교체부터 시작해보세요. CPU 온도가 80°C를 넘는다면 쿨러 문제일 가능성이 높아요.',
  hypotheses: [
    {
      id: 'hypo-a',
      priority: 'A',
      title: 'CPU 서멀 스로틀링',
      description: '팬 소음·발열이 갑자기 심해지는 증상은 CPU가 한계 온도(보통 95°C)에 도달해 클럭을 강제로 낮추는 서멀 스로틀링과 일치합니다. 쿨러 팬 먼지 청소 후 CPU 온도를 다시 확인해보세요.',
      confidence: 0.83,
      status: 'pending',
    },
    {
      id: 'hypo-b',
      priority: 'B',
      title: '백그라운드 프로세스 과다 점유',
      description: '부팅 시 자동 실행되는 프로그램이 CPU·메모리를 과다하게 점유하고 있을 수 있습니다. 작업 관리자(Ctrl+Shift+Esc) → 시작 프로그램 탭에서 불필요한 항목을 비활성화해보세요.',
      confidence: 0.65,
      status: 'pending',
    },
    {
      id: 'hypo-c',
      priority: 'C',
      title: 'GPU 드라이버 충돌',
      description: '그래픽 집약적 작업(게임·영상 편집) 중 발생하는 프레임 드랍과 블루스크린은 GPU 드라이버 불안정이 원인일 수 있습니다. DDU로 드라이버를 완전 제거 후 제조사 최신 버전을 새로 설치해보세요.',
      confidence: 0.48,
      status: 'pending',
    },
  ],
};

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }

  return res.json() as Promise<T>;
}

// ── Phase 1/5: SW 가설 생성 ──────────────────────────────────────────────────

export interface HypothesisRequestPayload {
  symptom: string;
  clipboardImage?: string;      // Base64 (data: prefix 제거)
  systemSnapshot?: Record<string, unknown>;
}

export function generateHypotheses(payload: HypothesisRequestPayload): Promise<HypothesesResponse> {
  if (USE_MOCK) return mockDelay(MOCK_HYPOTHESES);
  return post<HypothesesResponse>('/api/diagnosis/hypotheses', payload);
}

// ── Phase 5: SW 가설 확정 ────────────────────────────────────────────────────

export function confirmSoftwareDiagnosis(
  req: SoftwareDiagnosisRequest,
): Promise<SoftwareDiagnosisResponse> {
  return post<SoftwareDiagnosisResponse>('/api/diagnosis/software', req);
}

// ── Phase 5: 이벤트 로그 기반 패턴 제안 ─────────────────────────────────────

export function suggestPatterns(
  eventLog: EventLog[],
  symptom?: string,
): Promise<PatternsResponse> {
  return post<PatternsResponse>('/api/diagnosis/patterns', { eventLog, symptom });
}

// ── 공통: 피드백 ─────────────────────────────────────────────────────────────

export function sendFeedback(
  diagnosisId: string,
  status: 'RESOLVED' | 'UNRESOLVED',
): Promise<void> {
  return post<void>(`/api/diagnosis/${diagnosisId}/feedback`, { status });
}
