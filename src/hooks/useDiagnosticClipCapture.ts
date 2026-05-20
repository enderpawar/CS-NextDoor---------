import { useCallback, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import type { CvFrameInput, GuideContext, GuideOcrRegion } from '../types';
import { isHwRepairContext } from '../types';
import { analyzeFrame, compareHistograms } from '../lib/cv/frameMetrics';
import { runBiosPipeline } from '../lib/cv/biosPipeline';

const SAMPLE_INTERVAL_MS = 125;
const MAX_CAPTURE_MS = 4_000;
const MAX_ANALYSIS_SIDE = 640;
const MIN_CLIP_SAMPLES = 3;

export const DIAGNOSTIC_CLIP_LONG_PRESS_MS = 650;

export type DiagnosticClipMode = 'visual' | 'audio-only' | 'hybrid';

export interface DiagnosticClipResult {
  frameBase64: string;
  width: number;
  height: number;
  cvSummary: string;
  ocrRegions?: GuideOcrRegion[];
  captureMode: DiagnosticClipMode;
  qualityFeedback?: string;
}

interface DiagnosticClipFrame {
  frame: CvFrameInput;
  jpegBase64: string;
}

interface AudioSample {
  atMs: number;
  rms: number;
  peak: number;
}

interface AudioState {
  available: boolean;
  samples: AudioSample[];
  stream?: MediaStream;
  audioContext?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
  rafId?: number;
}

export function shouldStartDiagnosticClip(elapsedMs: number): boolean {
  return elapsedMs >= DIAGNOSTIC_CLIP_LONG_PRESS_MS;
}

export function hasEnoughDiagnosticClipSamples(sampledFrames: number): boolean {
  return sampledFrames >= MIN_CLIP_SAMPLES;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function countPeaks(values: number[], threshold: number): number {
  let peaks = 0;
  for (let i = 1; i < values.length - 1; i += 1) {
    const prev = values[i - 1] ?? 0;
    const current = values[i] ?? 0;
    const next = values[i + 1] ?? 0;
    if (current > prev && current >= next && current >= threshold) peaks += 1;
  }
  return peaks;
}

function makeSummary(fields: Record<string, string | number | boolean>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

export function buildDiagnosticClipSummary(args: {
  durationMs: number;
  sampledFrames: number;
  selectedFrames: number;
  brightnessValues: number[];
  sceneChangeScores: number[];
  audioAvailable: boolean;
  audioSamples: AudioSample[];
}): string {
  const durationSec = Math.max(0.001, args.durationMs / 1000);
  const brightnessDeltas = args.brightnessValues
    .slice(1)
    .map((value, index) => Math.abs(value - (args.brightnessValues[index] ?? value)));
  const brightnessDeltaMax = brightnessDeltas.length > 0 ? Math.max(...brightnessDeltas) : 0;
  const pulseThreshold = Math.max(0.06, brightnessDeltaMax * 0.55);
  const transitionPulseCount = Math.floor(
    brightnessDeltas.filter(delta => delta >= pulseThreshold).length / 2,
  );
  const brightnessPulseCount = Math.max(countPeaks(brightnessDeltas, pulseThreshold), transitionPulseCount);
  const brightnessPulseHz = brightnessPulseCount / durationSec;
  const sceneChangeCount = args.sceneChangeScores.filter(score => score >= 0.18).length;

  const audioRmsValues = args.audioSamples.map(sample => sample.rms);
  const audioRmsMean = audioRmsValues.length > 0
    ? audioRmsValues.reduce((sum, value) => sum + value, 0) / audioRmsValues.length
    : 0;
  const audioPeakThreshold = Math.max(0.12, audioRmsMean * 1.8);
  const audioPeakCount = args.audioSamples.filter(sample => sample.peak >= audioPeakThreshold).length;

  const ledBlinkLikely = brightnessPulseCount >= 2 && brightnessDeltaMax >= 0.10;
  const fanOrMotionLikely = sceneChangeCount >= 2 && !ledBlinkLikely;
  const beepOrNoiseLikely = args.audioAvailable && (audioPeakCount >= 2 || audioRmsMean >= 0.08);

  return makeSummary({
    captureSource: 'clip',
    clipDurationMs: Math.round(args.durationMs),
    sampledFrames: args.sampledFrames,
    selectedFrames: args.selectedFrames,
    brightnessPulseCount,
    brightnessPulseHz: brightnessPulseHz.toFixed(2),
    brightnessDeltaMax: brightnessDeltaMax.toFixed(3),
    sceneChangeCount,
    ledBlinkLikely,
    fanOrMotionLikely,
    audioAvailable: args.audioAvailable,
    audioPeakCount,
    audioRmsMean: audioRmsMean.toFixed(3),
    beepOrNoiseLikely,
  });
}

async function startAudioAnalysis(startedAt: number): Promise<AudioState> {
  if (!navigator.mediaDevices?.getUserMedia) return { available: false, samples: [] };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      stream.getTracks().forEach(track => track.stop());
      return { available: false, samples: [] };
    }

    const audioContext = new AudioContextCtor();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const state: AudioState = { available: true, samples: [], stream, audioContext, source, analyser };

    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      let sumSquares = 0;
      let peak = 0;
      for (const value of data) {
        sumSquares += value * value;
        peak = Math.max(peak, Math.abs(value));
      }
      state.samples.push({
        atMs: performance.now() - startedAt,
        rms: Math.sqrt(sumSquares / data.length),
        peak,
      });
      state.rafId = window.requestAnimationFrame(tick);
    };

    tick();
    return state;
  } catch {
    return { available: false, samples: [] };
  }
}

function stopAudioAnalysis(state: AudioState | null): AudioSample[] {
  if (!state) return [];
  if (state.rafId !== undefined) window.cancelAnimationFrame(state.rafId);
  state.source?.disconnect();
  state.stream?.getTracks().forEach(track => track.stop());
  void state.audioContext?.close();
  return state.samples;
}

function drawScaledFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): DiagnosticClipFrame | null {
  if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return null;

  const scale = Math.min(1, MAX_ANALYSIS_SIDE / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    frame: {
      id: `clip-${Math.round(performance.now())}`,
      width: imageData.width,
      height: imageData.height,
      data: new Uint8ClampedArray(imageData.data),
      timestampMs: performance.now(),
    },
    jpegBase64: canvas.toDataURL('image/jpeg', 0.82).split(',')[1] ?? '',
  };
}

function selectDiagnosticFrames(frames: DiagnosticClipFrame[]) {
  const candidates = frames.map((frame, index) => {
    const previous = index > 0 ? analyzeFrame(frames[index - 1]!.frame).histogram : undefined;
    const metrics = analyzeFrame(frame.frame, previous);
    return { ...frame, metrics };
  });

  const byQuality = [...candidates].sort((a, b) => b.metrics.qualityScore - a.metrics.qualityScore);
  const byChange = [...candidates].sort(
    (a, b) => (b.metrics.sceneChangeScore ?? 0) - (a.metrics.sceneChangeScore ?? 0),
  );
  const selected = new Map<string, (typeof candidates)[number]>();

  for (const candidate of byQuality.slice(0, 3)) selected.set(candidate.frame.id, candidate);
  for (const candidate of byChange.slice(0, 3)) selected.set(candidate.frame.id, candidate);

  const usableCount = candidates.filter(candidate => candidate.metrics.isUsable).length;

  return {
    candidates,
    selected: Array.from(selected.values()).slice(0, 5),
    representative: byQuality[0] ?? candidates[0],
    usableCount,
  };
}

export interface AudioFingerprint {
  peakCount: number;
  rmsMean: number;
  beepOrNoiseLikely: boolean;
}

function summarizeAudio(samples: AudioSample[], available: boolean): AudioFingerprint {
  if (!available || samples.length === 0) {
    return { peakCount: 0, rmsMean: 0, beepOrNoiseLikely: false };
  }
  const rmsValues = samples.map(sample => sample.rms);
  const rmsMean = rmsValues.reduce((sum, value) => sum + value, 0) / rmsValues.length;
  const peakThreshold = Math.max(0.12, rmsMean * 1.8);
  const peakCount = samples.filter(sample => sample.peak >= peakThreshold).length;
  return { peakCount, rmsMean, beepOrNoiseLikely: peakCount >= 2 || rmsMean >= 0.08 };
}

export function classifyDiagnosticClipMode(
  usableCount: number,
  audio: AudioFingerprint,
): { mode: DiagnosticClipMode; feedback?: string } {
  if (usableCount === 0 && audio.beepOrNoiseLikely) {
    return {
      mode: 'audio-only',
      feedback: '화면이 잘 안 보여서 소리 위주로 분석할게요.',
    };
  }
  if (usableCount > 0 && audio.beepOrNoiseLikely) {
    return { mode: 'hybrid' };
  }
  return { mode: 'visual' };
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export function useDiagnosticClipCapture({
  videoRef,
  cvReady,
  context,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  canvasRef: RefObject<HTMLCanvasElement>;
  cvReady: boolean;
  context: GuideContext;
}) {
  const framesRef = useRef<DiagnosticClipFrame[]>([]);
  const intervalRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const audioStateRef = useRef<AudioState | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const stopTimers = useCallback(() => {
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    if (maxTimerRef.current !== null) window.clearTimeout(maxTimerRef.current);
    intervalRef.current = null;
    maxTimerRef.current = null;
  }, []);

  const beginClipCapture = useCallback(async (onMaxDuration?: () => void) => {
    const video = videoRef.current;
    if (!video) return false;

    framesRef.current = [];
    const startedAt = performance.now();
    startedAtRef.current = startedAt;
    captureCanvasRef.current ??= document.createElement('canvas');
    audioStateRef.current = null;

    const captureFrame = () => {
      const frame = drawScaledFrame(video, captureCanvasRef.current!);
      if (frame?.jpegBase64) framesRef.current.push(frame);
    };

    captureFrame();
    intervalRef.current = window.setInterval(captureFrame, SAMPLE_INTERVAL_MS);
    maxTimerRef.current = window.setTimeout(() => {
      onMaxDuration?.();
    }, MAX_CAPTURE_MS);
    void startAudioAnalysis(startedAt).then(state => {
      if (startedAtRef.current === startedAt && intervalRef.current !== null) {
        audioStateRef.current = state;
      } else {
        stopAudioAnalysis(state);
      }
    });
    return true;
  }, [videoRef]);

  const cancelClipCapture = useCallback(() => {
    stopTimers();
    stopAudioAnalysis(audioStateRef.current);
    audioStateRef.current = null;
    framesRef.current = [];
  }, [stopTimers]);

  const finishClipCapture = useCallback(async (): Promise<DiagnosticClipResult | null> => {
    stopTimers();
    const durationMs = performance.now() - startedAtRef.current;
    const audioState = audioStateRef.current;
    audioStateRef.current = null;
    const audioSamples = stopAudioAnalysis(audioState);
    const frames = framesRef.current;
    framesRef.current = [];

    if (!hasEnoughDiagnosticClipSamples(frames.length)) return null;

    const { candidates, selected, representative, usableCount } = selectDiagnosticFrames(frames);
    if (!representative?.jpegBase64) return null;

    const brightnessValues = candidates.map(candidate => candidate.metrics.brightnessMean);
    const sceneChangeScores = candidates
      .map((candidate, index) => {
        if (candidate.metrics.sceneChangeScore !== undefined) return candidate.metrics.sceneChangeScore;
        if (index === 0) return 0;
        const previous = candidates[index - 1]?.metrics.histogram ?? [];
        return 1 - compareHistograms(previous, candidate.metrics.histogram);
      })
      .map(clamp01);

    const audioAvailable = !!audioState?.available;
    const audioFingerprint = summarizeAudio(audioSamples, audioAvailable);
    const { mode: captureMode, feedback: qualityFeedback } = classifyDiagnosticClipMode(usableCount, audioFingerprint);

    let cvSummary = buildDiagnosticClipSummary({
      durationMs,
      sampledFrames: frames.length,
      selectedFrames: selected.length,
      brightnessValues,
      sceneChangeScores,
      audioAvailable,
      audioSamples,
    });

    cvSummary = [
      cvSummary,
      `usableFrames=${usableCount}`,
      `analysisMode=${captureMode}`,
    ].join(', ');

    // audio-only 모드는 BIOS 화면 OCR이 의미 없음 (프레임 모두 품질 미달) — 비용 절약을 위해 스킵
    let ocrRegions: GuideOcrRegion[] | undefined;
    if (cvReady && !isHwRepairContext(context) && captureMode !== 'audio-only') {
      try {
        const ocrResult = await runBiosPipeline(new ImageData(
          new Uint8ClampedArray(representative.frame.data),
          representative.frame.width,
          representative.frame.height,
        ));
        ocrRegions = ocrResult.ocrRegions;
        cvSummary = [
          cvSummary,
          `ocrRegions=${ocrRegions.length}`,
          `ocrConfidence=${ocrResult.confidence.toFixed(2)}`,
        ].join(', ');
      } catch {
        cvSummary = `${cvSummary}, ocrRegions=0`;
      }
    }

    return {
      frameBase64: representative.jpegBase64,
      width: representative.frame.width,
      height: representative.frame.height,
      cvSummary,
      ocrRegions,
      captureMode,
      qualityFeedback,
    };
  }, [context, cvReady, stopTimers]);

  return useMemo(() => ({
    beginClipCapture,
    finishClipCapture,
    cancelClipCapture,
  }), [beginClipCapture, finishClipCapture, cancelClipCapture]);
}
