/**
 * AudioCapture — Phase 8
 *
 * 마이크 녹음(최대 10초) → /api/diagnosis/hardware 전송 → 비프음 분석 결과 표시.
 *
 * - MediaRecorder 결과(webm/mp4)는 Gemini inline audio 미지원 가능성이 있어 전송 전 WAV로 변환
 * - AEC/NS/AGC 비활성화 필수 — 활성 시 비프음 주파수 제거됨
 * - biosType 미선택 시 버튼 비활성화 (implementation-checklist.md 11-1)
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { BiosType, DiagnosisResponse, RecordingState } from '../../types';
import { API_BASE_URL } from '../../api/config';
import '../../styles/mobile.css';

const MAX_SEC     = 10;   // 최대 녹음 시간
const WAV_MIME    = 'audio/wav';

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
      const wavBlob = await convertRecordingToWav(blobRef.current);
      form.append('audio', wavBlob, 'beep.wav');
      form.append('audioMimeType', WAV_MIME);
      form.append('symptom', symptom);
      form.append('biosType', biosType);

      const res = await fetch(`${API_BASE_URL}/api/diagnosis/hardware`, { method: 'POST', body: form });
      if (!res.ok) {
        let message = `서버 오류 ${res.status}`;
        try {
          const errorBody = await res.json() as { error?: string };
          message = errorBody.error ?? message;
        } catch {
          // JSON 오류 응답이 아니면 상태 코드 메시지 사용
        }
        throw new Error(message);
      }
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

async function convertRecordingToWav(blob: Blob): Promise<Blob> {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error('이 브라우저에서는 오디오 변환을 지원하지 않아요.');
  }

  const audioContext = new AudioContextClass();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    return encodeWav(audioBuffer);
  } finally {
    void audioContext.close();
  }
}

function encodeWav(audioBuffer: AudioBuffer): Blob {
  const channelCount = Math.min(audioBuffer.numberOfChannels, 2);
  const sampleRate = audioBuffer.sampleRate;
  const samples = interleaveChannels(audioBuffer, channelCount);
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: WAV_MIME });
}

function interleaveChannels(audioBuffer: AudioBuffer, channelCount: number): Float32Array {
  const length = audioBuffer.length;
  const result = new Float32Array(length * channelCount);
  const channels = Array.from({ length: channelCount }, (_, i) => audioBuffer.getChannelData(i));

  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const channel = channels[ch];
      result[i * channelCount + ch] = channel ? channel[i] ?? 0 : 0;
    }
  }

  return result;
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
