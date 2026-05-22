// 라이브 카메라 가이드 API 레이어
// /api/guide/* 엔드포인트 래핑

import type { GuideContext, GuideMessage, GuideOcrRegion } from '../types';
import { API_BASE_URL } from './config';

export interface GuideStartResponse {
  sessionId: string;
}

export interface GalleryVideoFrameResponse {
  frameBase64: string;
  width: number;
  height: number;
  cvSummary: string;
}

/**
 * POST /api/guide/start
 * 가이드 세션 생성
 */
export async function startGuideSession(context: GuideContext): Promise<GuideStartResponse> {
  const res = await fetch(`${API_BASE_URL}/api/guide/start`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ context }),
  });
  if (!res.ok) throw new Error(`가이드 세션 시작 실패: ${res.status}`);
  return res.json() as Promise<GuideStartResponse>;
}

/**
 * POST /api/guide/{sessionId}/frame
 * 프레임 Base64 + 히스토리 → fetch() ReadableStream (SSE)
 * EventSource는 GET만 지원 → fetch + ReadableStream으로 POST 본문 전송
 */
export async function sendGuideFrame(
  sessionId: string,
  frameBase64: string,
  history: GuideMessage[],
  cvSummary?: string,
  ocrRegions?: GuideOcrRegion[],
  userQuestion?: string,
  taskGoal?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(`${API_BASE_URL}/api/guide/${sessionId}/frame`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ frameBase64, history, cvSummary, ocrRegions: ocrRegions ?? [], userQuestion, taskGoal }),
    signal,
  });
  if (!res.ok) throw new Error(`프레임 전송 실패: ${res.status}`);
  return res;
}

/**
 * POST /api/guide/gallery-video-frame
 * 브라우저가 직접 열 수 없는 iPhone HEVC/MOV 영상에서 서버가 대표 JPEG 프레임을 추출.
 */
export async function extractGalleryVideoFrame(file: File): Promise<GalleryVideoFrameResponse> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_BASE_URL}/api/guide/gallery-video-frame`, {
    method: 'POST',
    body:   formData,
  });
  if (!res.ok) {
    let message = `동영상 서버 분석 실패: ${res.status}`;
    try {
      const payload = await res.json() as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // keep status fallback
    }
    throw new Error(message);
  }
  return res.json() as Promise<GalleryVideoFrameResponse>;
}

/**
 * DELETE /api/guide/{sessionId}
 * 가이드 세션 종료
 */
export async function deleteGuideSession(sessionId: string): Promise<void> {
  await fetch(`${API_BASE_URL}/api/guide/${sessionId}`, { method: 'DELETE' });
}
