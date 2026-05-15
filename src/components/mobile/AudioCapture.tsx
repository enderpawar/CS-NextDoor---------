/**
 * AudioCapture — Phase 8
 *
 * 마이크 녹음(최대 10초) → /api/diagnosis/hardware 전송 → 비프음 분석 결과 표시.
 *
 * - iOS Safari: audio/webm 미지원 → audio/mp4 폴백
 * - AEC/NS/AGC 비활성화 필수 — 활성 시 비프음 주파수 제거됨
 * - biosType 미선택 시 버튼 비활성화 (implementation-checklist.md 11-1)
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { BiosType, DiagnosisResponse, RecordingState } from '../../types';
import '../../styles/mobile.css';

const API_BASE    = 'http://localhost:8080';
const MAX_SEC     = 10;   // 최대 녹음 시간

interface Props {
  biosType: BiosType | null;
  symptom?: string;
}

export default function AudioCapture({ biosType, symptom = '비프음 진단' }: Props) {
  const [recordState, setRecordState] = useState<RecordingState>('idle');
  const [elapsed,     setElapsed]     = useState(0);
  const [isLoading,   setIsLoading]   = useState(false);
  const [result,      setResult]      = useState<DiagnosisResponse | null>(null);
  const [error,       setError]       = useState('');

  const recorderRef  = useRef<MediaRecorder | null>(null);
  const chunksRef    = useRef<Blob[]>([]);
  const blobRef      = useRef<Blob | null>(null);
  const mimeTypeRef  = useRef<string>('audio/webm');
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef    = useRef<MediaStream | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setElapsed(0);
  }, []);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    stopTimer();
  }, [stopTimer]);

  // 최대 녹음 시간 자동 종료
  useEffect(() => {
    if (recordState !== 'recording') return;
    if (elapsed >= MAX_SEC) stopRecording();
  }, [elapsed, recordState, stopRecording]);

  const startRecording = useCallback(async () => {
    setError('');
    setResult(null);
    chunksRef.current = [];
    blobRef.current   = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,    // 비프음 주파수 제거 방지
          noiseSuppression: false,
          autoGainControl:  false,
        },
      });
      streamRef.current = stream;

      // iOS Safari: audio/webm 미지원 → audio/mp4
      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';
      mimeTypeRef.current = mimeType;

      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;

      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        blobRef.current = new Blob(chunksRef.current, { type: mimeTypeRef.current });
        setRecordState('recorded');
      };

      recorder.start(200);  // 200ms 단위 청크
      setRecordState('recording');
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } catch {
      setError('마이크 권한이 필요해요. 브라우저 설정에서 허용해주세요.');
    }
  }, []);

  const handleSend = useCallback(async () => {
    if (!blobRef.current || !biosType) return;
    setIsLoading(true);
    setError('');

    try {
      const form = new FormData();
      // 백엔드는 multipart/form-data 기대 — image 필드 필수이므로 1×1 더미 이미지 전송
      const dummyImage = new Blob(
        [new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9])],
        { type: 'image/jpeg' },
      );
      form.append('image', dummyImage, 'placeholder.jpg');
      form.append('audio', blobRef.current, `beep.${mimeTypeRef.current === 'audio/mp4' ? 'mp4' : 'webm'}`);
      form.append('audioMimeType', mimeTypeRef.current);
      form.append('symptom', symptom);
      form.append('biosType', biosType);

      const res = await fetch(`${API_BASE}/api/diagnosis/hardware`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`서버 오류 ${res.status}`);
      const data: DiagnosisResponse = await res.json();
      setResult(data);
    } catch (e) {
      setError((e as Error).message ?? '전송에 실패했어요. 다시 시도해주세요.');
    } finally {
      setIsLoading(false);
    }
  }, [biosType, symptom]);

  // 언마운트 시 스트림 정리
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const formatTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const canRecord = biosType !== null && recordState !== 'recording';

  return (
    <div className="nd-audio-capture">
      <span className="nd-audio-capture-label">비프음 녹음</span>

      {/* 타이머 */}
      {recordState === 'recording' && (
        <div className="nd-audio-timer">{formatTime(elapsed)} / {formatTime(MAX_SEC)}</div>
      )}
      {recordState === 'recorded' && blobRef.current && (
        <p className="nd-audio-hint">녹음 완료 ({(blobRef.current.size / 1024).toFixed(0)} KB)</p>
      )}
      {recordState === 'idle' && (
        <p className="nd-audio-hint">
          {biosType ? 'PC 부팅 시 비프음이 나면 버튼을 눌러 녹음해주세요.' : 'BIOS 제조사를 먼저 선택해주세요.'}
        </p>
      )}

      {/* 마이크 버튼 */}
      <button
        type="button"
        className={`nd-audio-mic-btn${recordState === 'recording' ? ' recording' : ''}`}
        onClick={recordState === 'recording' ? stopRecording : startRecording}
        disabled={!canRecord && recordState !== 'recording'}
        aria-label={recordState === 'recording' ? '녹음 중지' : '녹음 시작'}
      >
        {recordState === 'recording' ? '⏹' : '🎙'}
      </button>

      {/* 전송 버튼 */}
      {recordState === 'recorded' && (
        <button
          type="button"
          className="nd-audio-send-btn"
          onClick={handleSend}
          disabled={isLoading || !biosType}
        >
          {isLoading ? '분석 중...' : '비프음 분석 요청'}
        </button>
      )}

      {error && <p style={{ fontSize: '0.8rem', color: '#dc2626', textAlign: 'center' }}>{error}</p>}

      {/* 분석 결과 */}
      {result && (
        <div className="nd-audio-result-card">
          <div className="nd-audio-result-title">진단 결과</div>
          <p>{result.cause}</p>
          <p style={{ marginTop: '0.5rem', whiteSpace: 'pre-line', fontSize: '0.82rem' }}>{result.solution}</p>
          <span className={`nd-audio-confidence ${result.confidence >= 0.6 ? 'high' : 'low'}`}>
            확신도 {Math.round(result.confidence * 100)}%
            {result.confidence < 0.6 && ' — 수리기사 상담 권장'}
          </span>
        </div>
      )}

      {/* 다시 녹음 */}
      {(recordState === 'recorded' || result) && !isLoading && (
        <button
          type="button"
          style={{
            background: 'none', border: 'none', color: 'var(--color-text-secondary, #5d6274)',
            fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline', alignSelf: 'center',
          }}
          onClick={() => { setRecordState('idle'); setResult(null); setError(''); }}
        >
          다시 녹음하기
        </button>
      )}
    </div>
  );
}
