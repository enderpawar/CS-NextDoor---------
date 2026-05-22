# 코드 스니펫 — Phase별 구현 레퍼런스

> **진단 모드 분리 원칙**
> - Mobile PWA  → 하드웨어 진단 (카메라/마이크 입력)
> - Desktop Electron → 소프트웨어 진단 (OS 시스템 데이터 수집)

---

## Phase 4 — eventLogReader.ts (Windows 이벤트 로그)

> **[!WARNING]** `ExecutionPolicy: Restricted` 환경에서는 `-ExecutionPolicy Bypass` 플래그 필요.
> Security 로그는 관리자 권한 필요 — System/Application 로그는 일반 권한으로 접근 가능.

```ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface EventLogEntry {
  TimeCreated: string;
  Id: number;
  LevelDisplayName: string;
  Message: string;
}

// execSync 대신 exec + Promise — Get-WinEvent 수집 시 메인 프로세스 블로킹 방지
// 이벤트 1개일 때 ConvertTo-Json이 배열이 아닌 객체를 반환 → 정규화 필수
function normalizeJson(raw: string): EventLogEntry[] {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Windows Event Log에서 최근 에러/경고 수집
export async function getEventLogs(maxEvents = 30): Promise<EventLogEntry[]> {
  try {
    const ps = `
      Get-WinEvent -LogName System -MaxEvents ${maxEvents} |
      Where-Object { $_.Level -le 2 } |
      Select-Object TimeCreated, Id, LevelDisplayName, Message |
      ConvertTo-Json
    `;
    const { stdout } = await execAsync(
      `powershell -ExecutionPolicy Bypass -Command "${ps}"`,
      { encoding: 'utf8' }
    );
    return normalizeJson(stdout);
  } catch {
    return [];  // 권한 부족 또는 비-Windows 환경
  }
}

// Application 로그 (앱 크래시, 드라이버 오류)
export async function getAppLogs(maxEvents = 20): Promise<EventLogEntry[]> {
  try {
    const ps = `
      Get-WinEvent -LogName Application -MaxEvents ${maxEvents} |
      Where-Object { $_.Level -le 2 } |
      Select-Object TimeCreated, Id, ProviderName, Message |
      ConvertTo-Json
    `;
    const { stdout } = await execAsync(
      `powershell -ExecutionPolicy Bypass -Command "${ps}"`,
      { encoding: 'utf8' }
    );
    return normalizeJson(stdout);
  } catch {
    return [];
  }
}
```

---

## Phase 4 — processAnalyzer.ts (고부하 프로세스)

```ts
import si from 'systeminformation';

interface ProcessSummary {
  name: string;
  pid: number;
  cpu: string;
  mem: string;
}

export async function getTopProcesses(limit = 10): Promise<{
  byCpu: ProcessSummary[];
  byMem: ProcessSummary[];
  total: number;
}> {
  const procs = await si.processes();

  const toSummary = (p: si.Systeminformation.ProcessesProcessData): ProcessSummary => ({
    name: p.name,
    pid: p.pid,
    cpu: p.cpu.toFixed(1),
    mem: (p.mem / 1024).toFixed(0),
  });

  const byCpu = [...procs.list].sort((a, b) => b.cpu - a.cpu).slice(0, limit).map(toSummary);
  const byMem = [...procs.list].sort((a, b) => b.mem - a.mem).slice(0, limit).map(toSummary);

  return { byCpu, byMem, total: procs.all };
}
```

---

## Phase 5 — DiagnosisController.java (/software 엔드포인트)

```java
@PostMapping("/software")
public ResponseEntity<DiagnosisResponse> diagnoseSoftware(
        @RequestBody SoftwareSnapshotRequest req) {

    // systemSnapshot: { cpuLoad, temperature, memory, topProcesses, eventLogs }
    String result = diagnosisService.diagnoseSoftware(req);
    return ResponseEntity.ok(new DiagnosisResponse(result));
}

// SoftwareSnapshotRequest DTO
public record SoftwareSnapshotRequest(
    String symptom,
    String cpuLoad,
    Map<String, Object> temperature,
    Map<String, Object> memory,
    List<Map<String, Object>> topProcesses,
    List<Map<String, Object>> eventLogs
) {}
```

---

## Phase 5 — HypothesisController.java (/hypotheses 엔드포인트)

```java
// POST /api/diagnosis/hypotheses
// 증상 텍스트 + 시스템 스냅샷 → Gemini 분석 → 가설 A/B/C + 즉시 조치 반환
@PostMapping("/hypotheses")
public ResponseEntity<HypothesisResponse> generateHypotheses(
        @RequestBody SoftwareSnapshotRequest req) {

    HypothesisResponse response = diagnosisService.generateHypotheses(req);
    return ResponseEntity.ok(response);
}

// DTO — src/types/index.ts의 HypothesesResponse / Hypothesis 와 일치
public record HypothesisResponse(
    String diagnosisId,
    List<HypothesisDto> hypotheses,
    String immediateAction          // nullable
) {}

public record HypothesisDto(
    String id,
    String title,
    String description,
    String priority,                // "A" | "B" | "C"
    double confidence,              // 0.0 ~ 1.0
    String status                   // "pending" | "trying" | "resolved" | "failed"
) {}
```

---

## Phase 5 — SymptomInput.tsx (증상 입력 + 클립보드 이미지 첨부)

```tsx
import { useState, useRef, useCallback } from 'react';
import { HypothesesResponse } from '../../types';

interface Props {
  systemSnapshot: Record<string, unknown>;
  onHypothesesReady: (data: HypothesesResponse) => void;
}

// 증상 텍스트 입력 + Ctrl+V 클립보드 이미지 첨부 → /api/diagnosis/hypotheses 호출
export default function SymptomInput({ systemSnapshot, onHypothesesReady }: Props) {
  const [symptom, setSymptom] = useState('');
  const [clipImage, setClipImage] = useState<string | null>(null);  // Base64
  const [loading, setLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Ctrl+V — clipboard image 붙여넣기
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => setClipImage(reader.result as string);
        reader.readAsDataURL(file);
        e.preventDefault();
        break;
      }
    }
  }, []);

  const submit = async () => {
    if (!symptom.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/diagnosis/hypotheses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symptom,
          clipboardImage: clipImage?.split(',')[1] ?? null,  // Base64 only
          ...systemSnapshot,
        }),
      });
      const data: HypothesesResponse = await res.json();
      onHypothesesReady(data);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2>어떤 문제를 겪고 계신가요?</h2>
      <textarea
        ref={textareaRef}
        value={symptom}
        onChange={e => setSymptom(e.target.value)}
        onPaste={handlePaste}
        placeholder="예: 게임할 때 갑자기 버벅거리고 팬이 엄청 돌아요 (Ctrl+V로 스크린샷 첨부 가능)"
        rows={3}
        style={{ width: '100%' }}
      />
      {clipImage && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <img src={clipImage} alt="첨부 이미지" style={{ height: 48, borderRadius: 4 }} />
          <button onClick={() => setClipImage(null)}>✕ 제거</button>
        </div>
      )}
      <button onClick={submit} disabled={loading || !symptom.trim()}>
        {loading ? '분석 중...' : '진단 시작'}
      </button>
    </div>
  );
}
```

---

## Phase 5 — HypothesisList.tsx (가설 카드)

```tsx
import { useState } from 'react';
import { HypothesesResponse, Hypothesis } from '../../types';
import ReproductionMode from './ReproductionMode';

interface Props {
  data: HypothesesResponse;
  systemSnapshot: Record<string, unknown>;
}

export default function HypothesisList({ data, systemSnapshot }: Props) {
  const [selected, setSelected] = useState<Hypothesis | null>(null);

  if (selected) {
    return (
      <ReproductionMode
        hypothesis={selected}
        systemSnapshot={systemSnapshot}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <div>
      {data.immediateAction && (
        <p style={{ fontWeight: 'bold' }}>즉시 조치: {data.immediateAction}</p>
      )}

      {data.hypotheses.map(h => (
        <div key={h.id} style={{ border: '1px solid #333', borderRadius: 8, padding: 16, marginBottom: 12 }}>
          <h3>[{h.priority}] {h.title}</h3>
          <p>{h.description}</p>
          {/* confidence < 0.6 → 수리기사 권장 배너 */}
          {h.confidence < 0.6 && (
            <p style={{ color: 'red' }}>⚠️ 확신도 낮음 — 수리기사 상담 권장</p>
          )}
          <p>확신도: {Math.round(h.confidence * 100)}%</p>
          <button onClick={() => setSelected(h)}>🔬 이 가설로 재현 모니터링</button>
        </div>
      ))}
    </div>
  );
}
```

---

## Phase 5 — ReproductionMode.tsx (재현 모니터링)

```tsx
import { useState } from 'react';
import { Hypothesis } from '../../types';
import { useReproductionMonitor } from '../../hooks/useReproductionMonitor';

interface Props {
  hypothesis: Hypothesis;
  systemSnapshot: Record<string, unknown>;
  onBack: () => void;
}

// 베이스라인 저장 → 사용자가 문제 재현 → 델타 비교 → 서버 전송
export default function ReproductionMode({ hypothesis, systemSnapshot, onBack }: Props) {
  const { phase, baseline, delta, startBaseline, startReproduction, stopReproduction } =
    useReproductionMonitor();
  const [result, setResult] = useState<string | null>(null);

  const diagnose = async () => {
    const res = await fetch('/api/diagnosis/software', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symptom: hypothesis.title,
        selectedHypothesis: hypothesis.priority,
        baseline,
        delta,
        ...systemSnapshot,
      }),
    });
    const data = await res.json();
    setResult(data.result as string);
  };

  if (result) {
    return (
      <div>
        <h3>진단 결과</h3>
        <p>{result}</p>
        <button onClick={onBack}>← 돌아가기</button>
      </div>
    );
  }

  return (
    <div>
      <h3>🔬 재현 모니터링</h3>
      <p><strong>선택된 가설:</strong> {hypothesis.title}</p>

      {phase === 'idle' && (
        <button onClick={startBaseline}>1단계: 베이스라인 측정 시작</button>
      )}
      {phase === 'baseline' && (
        <p>베이스라인 측정 중... 잠시 정상 상태로 대기해주세요.</p>
      )}
      {phase === 'ready' && (
        <>
          <p>✅ 베이스라인 저장됨. 이제 문제 상황을 재현해보세요.</p>
          <button onClick={startReproduction}>2단계: 재현 시작</button>
        </>
      )}
      {phase === 'reproducing' && (
        <>
          <p>⏺ 모니터링 중... 문제가 발생하면 종료하세요.</p>
          <button onClick={stopReproduction}>재현 종료 + 분석</button>
        </>
      )}
      {phase === 'done' && (
        <button onClick={diagnose}>AI 가설 확정 요청</button>
      )}

      <button onClick={onBack} style={{ marginTop: 12 }}>← 가설 목록으로</button>
    </div>
  );
}
```

---

## Phase 5 — useReproductionMonitor.ts

```ts
import { useState, useRef, useCallback } from 'react';

type Phase = 'idle' | 'baseline' | 'ready' | 'reproducing' | 'done';

interface SystemSnapshot {
  ts: number;
  [key: string]: unknown;
}

// 베이스라인 스냅샷 저장 → 재현 중 델타 수집 → phase 관리
export function useReproductionMonitor() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [baseline, setBaseline] = useState<SystemSnapshot | null>(null);
  const [delta, setDelta] = useState<SystemSnapshot[] | null>(null);
  const snapshotsRef = useRef<SystemSnapshot[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const collectSnapshot = useCallback(async () => {
    const info = await window.electronAPI.getSystemInfo();
    snapshotsRef.current.push({ ...info, ts: Date.now() });
  }, []);

  const startBaseline = useCallback(async () => {
    setPhase('baseline');
    snapshotsRef.current = [];
    await collectSnapshot();
    await new Promise(r => setTimeout(r, 2500));
    await collectSnapshot();
    setBaseline(snapshotsRef.current[snapshotsRef.current.length - 1]);
    snapshotsRef.current = [];
    setPhase('ready');
  }, [collectSnapshot]);

  const startReproduction = useCallback(() => {
    setPhase('reproducing');
    snapshotsRef.current = [];
    intervalRef.current = setInterval(collectSnapshot, 2000);
  }, [collectSnapshot]);

  const stopReproduction = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setDelta(snapshotsRef.current);
    setPhase('done');
  }, []);

  return { phase, baseline, delta, startBaseline, startReproduction, stopReproduction };
}
```

---

## Phase 7 — VideoAnalysis.tsx (영상+오디오 통합 촬영)

> **[!NOTE]** 영상(프레임 배열)과 오디오(Blob)를 단일 액션으로 동시 수집.
> 비프음은 부팅 직후 발생하므로 **촬영 시작 후 PC 전원을 켜도록** UX 안내 문구 필요.

> **[!WARNING]** iOS Safari는 `audio/webm`을 지원하지 않습니다. `MediaRecorder.isTypeSupported` 분기로 `audio/mp4` 폴백 처리됨.
> Gemini API 전송 시 mime type도 실제 녹음 포맷과 반드시 일치시켜야 합니다.

프레임 선별 전략:
- 1초 간격으로 15개 캡처 → 흔들림 프레임 자동 제외(Laplacian) → 이상도 상위 5개만 Gemini 전송

`onFramesReady(frames, audioBlob, mimeType, scoreSummary)`
- `frames`: Base64 JPEG 배열 (최대 5개, 이상도 내림차순)
- `scoreSummary`: `{ total, sent, blurDiscarded, max, avg, frameScores }`

```tsx
import { useRef, useState, useCallback } from 'react';
import { processFrame } from '../mobile/CameraView';

const CAPTURE_TOTAL = 15;
const SEND_TOP      = 5;
const INTERVAL_SEC  = 1.0;

interface FrameCandidate {
  dataUrl: string;
  qualityScore: number;
  blurScore: number;
}

interface Props {
  onFramesReady: (
    frames: string[],
    audioBlob: Blob,
    mimeType: string,
    scoreSummary: object
  ) => void;
}

export default function VideoAnalysis({ onFramesReady }: Props) {
  const videoRef         = useRef<HTMLVideoElement>(null);
  const canvasRef        = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const intervalRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef   = useRef<Blob[]>([]);
  const candidatesRef    = useRef<FrameCandidate[]>([]);
  const blurCountRef     = useRef(0);
  const readyCountRef    = useRef(0);

  const [recording, setRecording]       = useState(false);
  const [captureCount, setCaptureCount] = useState(0);
  const [blurCount, setBlurCount]       = useState(0);

  const stopRecording = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    audioRecorderRef.current?.stop();
    videoRef.current?.srcObject?.getTracks().forEach(t => t.stop());
    setRecording(false);
  }, []);

  const captureAndScore = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || video.readyState < 2) return;

    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    const result = processFrame(video, canvas, readyCountRef.current);

    if (result.guidance === 'stabilize') {
      blurCountRef.current += 1;
      setBlurCount(blurCountRef.current);
    } else {
      if (result.isReadyToCapture) readyCountRef.current = 0;
      else readyCountRef.current = result.guidance === 'ready' ? readyCountRef.current + 1 : 0;

      candidatesRef.current.push({
        dataUrl: canvas.toDataURL('image/jpeg', 0.7),
        qualityScore: result.qualityScore,
        blurScore: result.blurScore,
      });
      setCaptureCount(c => c + 1);
    }

    if (candidatesRef.current.length + blurCountRef.current >= CAPTURE_TOTAL) stopRecording();
  }, [stopRecording]);

  const start = async () => {
    candidatesRef.current  = [];
    audioChunksRef.current = [];
    blurCountRef.current   = 0;
    readyCountRef.current  = 0;
    setCaptureCount(0);
    setBlurCount(0);

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: true,
    });
    if (videoRef.current) videoRef.current.srcObject = stream;
    setRecording(true);
    intervalRef.current = setInterval(captureAndScore, INTERVAL_SEC * 1000);

    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
    const audioRecorder = new MediaRecorder(stream, { mimeType });
    audioRecorder.ondataavailable = e => audioChunksRef.current.push(e.data);
    audioRecorder.onstop = () => {
      const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
      const sorted   = [...candidatesRef.current].sort((a, b) => b.qualityScore - a.qualityScore);
      const selected = sorted.slice(0, SEND_TOP);
      const scores   = candidatesRef.current.map(f => f.qualityScore);
      const scoreSummary = {
        total: candidatesRef.current.length,
        sent: selected.length,
        blurDiscarded: blurCountRef.current,
        max: scores.length ? Math.max(...scores) : 0,
        avg: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
        frameScores: sorted.map(f => ({ score: f.qualityScore.toFixed(1), blur: f.blurScore.toFixed(0) })),
      };
      onFramesReady(selected.map(f => f.dataUrl), audioBlob, mimeType, scoreSummary);
    };
    audioRecorder.start();
    audioRecorderRef.current = audioRecorder;
  };

  const progress = Math.round(((captureCount + blurCount) / CAPTURE_TOTAL) * 100);

  return (
    <div>
      <video ref={videoRef} autoPlay muted playsInline style={{ width: '100%' }} />
      {recording && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>선명 프레임 {captureCount}개</span>
            <span>흔들림 제외 {blurCount}개</span>
            <span>{progress}%</span>
          </div>
          <p style={{ fontSize: 12, color: '#6b7684' }}>
            OpenCV 채점 중 — 이상도 상위 {SEND_TOP}개 프레임을 AI로 전송합니다
          </p>
        </div>
      )}
      {!recording
        ? <button onClick={start}>🎥 촬영 시작 (영상+오디오)</button>
        : <button onClick={stopRecording}>⏹️ 촬영 종료 + 분석</button>
      }
    </div>
  );
}
```

---

## Phase 2 — Electron main.ts (앱 진입점)

```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),  // TS 빌드 후 .js 출력
      contextIsolation: true,   // 보안: 필수
      nodeIntegration: false,   // 보안: 필수
    },
  });

  const isDev = process.env.NODE_ENV === 'development';
  win.loadURL(isDev ? 'http://localhost:3000' : `file://${path.join(__dirname, '../dist/index.html')}`);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
```

---

## Phase 2 — preload.ts (IPC 브리지)

```ts
import { contextBridge, ipcRenderer } from 'electron';

// renderer(React)에서 window.electronAPI.* 로 접근
// src/types/electron.d.ts에 ElectronAPI interface 선언 필요
contextBridge.exposeInMainWorld('electronAPI', {
  getSystemInfo:        () => ipcRenderer.invoke('get-system-info'),
  onSystemUpdate:       (cb: (data: unknown) => void) =>
                          ipcRenderer.on('system-update', (_, data) => cb(data)),
  removeSystemListener: () => ipcRenderer.removeAllListeners('system-update'),
});
```

---

## Phase 3 — systemMonitor.ts (systeminformation 수집)

```ts
import si from 'systeminformation';
import { ipcMain, BrowserWindow } from 'electron';

// 1회 조회
ipcMain.handle('get-system-info', async () => {
  const [cpu, mem, graphics, temp] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.graphics(),
    si.cpuTemperature(),
  ]);

  return {
    cpu: {
      load: cpu.currentLoad.toFixed(1),
      cores: cpu.cpus.map(c => c.load.toFixed(1)),
    },
    memory: {
      used:  (mem.used  / 1024 ** 3).toFixed(1),  // GB
      total: (mem.total / 1024 ** 3).toFixed(1),
    },
    gpu: graphics.controllers[0] ? {
      model: graphics.controllers[0].model,
      vram:  graphics.controllers[0].vram,         // MB
      // 사용률·온도 수집 불가 — UI와 Gemini 프롬프트에 명시 필요
    } : null,
    temperature: {
      cpu: temp.main ?? null,  // °C. AMD/일부 OEM에서 null 반환 → "측정 불가" 처리
    },
  };
});

// 주기적 푸시 (2초마다)
export function startMonitoring(win: BrowserWindow): void {
  setInterval(async () => {
    const load = await si.currentLoad();
    win.webContents.send('system-update', {
      cpuLoad: load.currentLoad.toFixed(1),
    });
  }, 2000);
}
```

---

## Phase 3 — useSystemInfo.ts (React 훅 — IPC 통합)

> **[!WARNING]** React 18 Strict Mode에서 `useEffect`가 2회 실행됩니다. `onSystemUpdate`의 `ipcRenderer.on()`이 이중 등록되어 콜백이 2번 호출될 수 있습니다. `on()` 직전에 `removeAllListeners('system-update')`를 선행 호출하세요.

```ts
import { useState, useEffect } from 'react';

interface SystemInfo {
  cpu: { load: string; cores: string[] };
  memory: { used: string; total: string };
  gpu: { model: string; vram: number } | null;
  temperature: { cpu: number | null };
}

export function useSystemInfo(): { sysInfo: SystemInfo | null; isElectron: boolean } {
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const isElectron = !!window.electronAPI;

  useEffect(() => {
    if (!isElectron) return;

    // Strict Mode 이중 등록 방지
    window.electronAPI.removeSystemListener();
    window.electronAPI.getSystemInfo().then(setSysInfo);

    window.electronAPI.onSystemUpdate((data: Partial<SystemInfo['cpu']>) => {
      setSysInfo(prev => prev ? { ...prev, cpu: { ...prev.cpu, ...data } } : null);
    });

    return () => window.electronAPI.removeSystemListener();
  }, []);

  return { sysInfo, isElectron };
}
```

---

## Phase 2 — useRuntimeMode.ts (Electron/PWA/독립모드 감지)

```ts
import { RuntimeMode } from '../types';

// URL에 ?session= 파라미터 없으면 standalone (PC 부팅 불가 직접 진입)
// standalone: WS 연결 없음, QR UI 숨김, HTTP 응답만으로 결과 수신
export function useRuntimeMode(): RuntimeMode {
  if (window.electronAPI) return 'electron';
  const hasSession = new URLSearchParams(location.search).has('session');
  return hasSession ? 'pwa-session' : 'pwa-standalone';
}
```

---

## Phase 3 — useFpsMonitor.ts (실시간 FPS + 드랍 감지)

```ts
import { useRef, useState, useCallback } from 'react';

interface FpsDrop {
  timestamp: string;
  fps: number;
  baseline: number;
  dropPercent: number;
}

export function useFpsMonitor() {
  const [fps, setFps] = useState<number | null>(null);
  const [drops, setDrops] = useState<FpsDrop[]>([]);
  const rafRef       = useRef<number | null>(null);
  const lastTimeRef  = useRef(performance.now());
  const frameCountRef = useRef(0);
  const fpsHistoryRef = useRef<number[]>([]);

  const start = useCallback(() => {
    fpsHistoryRef.current = [];

    const tick = (now: number) => {
      frameCountRef.current++;
      const elapsed = now - lastTimeRef.current;

      if (elapsed >= 1000) {
        const currentFps = Math.round((frameCountRef.current * 1000) / elapsed);
        setFps(currentFps);

        const history = fpsHistoryRef.current;
        history.push(currentFps);
        if (history.length > 10) history.shift();

        // 절대값(30fps) 기준이 아닌 베이스라인 대비 20% 이상 드롭 시 기록
        if (history.length >= 5) {
          const baseline = history.slice(0, -1).reduce((a, b) => a + b, 0) / (history.length - 1);
          const dropRatio = (baseline - currentFps) / baseline;
          if (dropRatio > 0.2) {
            setDrops(prev => [...prev.slice(-19), {
              timestamp: new Date().toLocaleTimeString(),
              fps: currentFps,
              baseline: Math.round(baseline),
              dropPercent: Math.round(dropRatio * 100),
            }]);
          }
        }

        frameCountRef.current = 0;
        lastTimeRef.current = now;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const observeLongTasks = useCallback(() => {
    if (!('PerformanceObserver' in window)) return;
    const observer = new PerformanceObserver(list => {
      list.getEntries().forEach(entry => {
        console.warn(`Long Task: ${entry.duration.toFixed(0)}ms`);
      });
    });
    observer.observe({ entryTypes: ['longtask'] });
    return () => observer.disconnect();
  }, []);

  return { fps, drops, start, stop, observeLongTasks };
}
```

> **[!NOTE]** `drops` 배열에 `baseline`과 `dropPercent`를 포함해 Gemini에 전달하면 GPU 병목·CPU 과부하·드라이버 충돌 등 원인 추론이 가능합니다.

---

## Phase 3 — FpsDashboard.tsx

```tsx
import { useEffect } from 'react';
import { useFpsMonitor } from '../../hooks/useFpsMonitor';

interface Props {
  onDiagnoseRequest: (drops: ReturnType<typeof useFpsMonitor>['drops']) => void;
}

export default function FpsDashboard({ onDiagnoseRequest }: Props) {
  const { fps, drops, start, stop, observeLongTasks } = useFpsMonitor();

  useEffect(() => {
    start();
    const cleanup = observeLongTasks();
    return () => { stop(); cleanup?.(); };
  }, []);

  const fpsColor = fps === null ? '#aaa' : fps >= 50 ? '#00FF88' : fps >= 30 ? '#FFA500' : '#FF4444';

  return (
    <div className="fps-dashboard">
      <div className="fps-gauge" style={{ color: fpsColor }}>
        <span className="fps-value">{fps ?? '--'}</span>
        <span className="fps-label">FPS</span>
      </div>

      {drops.length > 0 && (
        <div className="drop-log">
          <h4>⚠️ 프레임 드랍 감지됨</h4>
          {drops.map((d, i) => (
            <div key={i}>{d.timestamp} — {d.fps}fps (베이스라인 {d.baseline}fps 대비 {d.dropPercent}% 드롭)</div>
          ))}
          <button onClick={() => onDiagnoseRequest(drops)}>
            AI에게 원인 분석 요청
          </button>
        </div>
      )}
    </div>
  );
}
```

---

## Phase 6 — manifest.json (PWA)

```json
{
  "name": "옆집 컴공생",
  "short_name": "NextDoor CS",
  "description": "AI 하드웨어 진단 서비스",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#f9f9f9",
  "theme_color": "#4355b9",
  "orientation": "any",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

## Phase 6 — Service Worker (sw.js)

```js
// sw.js — pwa/public/sw.js. TS 빌드 대상 제외 (평문 JS 유지)
// WARNING: 배포마다 버전을 올려야 합니다 (nextdoorcs-v2, v3...). 고정 시 구버전 캐시가 새 API와 충돌합니다.
const CACHE = 'nextdoorcs-v1';
const PRECACHE = ['/', '/index.html', '/opencv.js'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)))
);

self.addEventListener('fetch', e => {
  // API 요청은 항상 네트워크 우선
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
```

---

## Phase 1 — GeminiService.java

```java
@Service
@RequiredArgsConstructor
public class GeminiService {

    @Value("${gemini.api.key}")
    private String apiKey;

    private static final String GEMINI_URL =
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent";

    private final RestTemplate restTemplate;

    public String diagnoseImage(String base64Image, String symptomText) {
        Map<String, Object> requestBody = Map.of(
            "contents", List.of(Map.of(
                "parts", List.of(
                    Map.of("text", "증상: " + symptomText),
                    Map.of("inline_data", Map.of(
                        "mime_type", "image/jpeg",
                        "data", base64Image
                    ))
                )
            ))
        );

        String url = GEMINI_URL + "?key=" + apiKey;
        Map<String, Object> response = restTemplate.postForObject(url, requestBody, Map.class);
        return extractText(response);
    }

    // Phase 8 확장: 이미지 + 오디오 멀티모달
    // audioMimeType: 프론트엔드에서 실제 녹음된 포맷 전달 필수 ("audio/webm" | "audio/mp4")
    public String diagnoseMultimodal(String base64Image, byte[] audioBytes, String audioMimeType, String symptom) {
        List<Map<String, Object>> parts = new ArrayList<>(List.of(
            Map.of("text", "증상: " + symptom),
            Map.of("inline_data", Map.of("mime_type", "image/jpeg", "data", base64Image))
        ));
        if (audioBytes != null && audioMimeType != null) {
            parts.add(Map.of("inline_data", Map.of(
                "mime_type", audioMimeType,
                "data", Base64.getEncoder().encodeToString(audioBytes)
            )));
        }
        Map<String, Object> requestBody = Map.of(
            "contents", List.of(Map.of("parts", parts))
        );
        return extractText(restTemplate.postForObject(GEMINI_URL + "?key=" + apiKey, requestBody, Map.class));
    }

    // WARNING: null 방어 없음 — API 오류(404/401)/모델 미존재/빈 응답 시 NPE 발생
    // Phase 1 구현 시 response null 체크 후 DiagnosisException 처리 필수
    @SuppressWarnings("unchecked")
    private String extractText(Map<String, Object> response) {
        var candidates = (List<Map<String, Object>>) response.get("candidates");
        var content = (Map<String, Object>) candidates.get(0).get("content");
        var parts = (List<Map<String, Object>>) content.get("parts");
        return (String) parts.get(0).get("text");
    }
}
```

## Phase 1 — DiagnosisController.java

```java
@RestController
@RequestMapping("/api/diagnosis")
@RequiredArgsConstructor
public class DiagnosisController {

    private final DiagnosisService diagnosisService;

    @PostMapping("/hardware")
    public ResponseEntity<DiagnosisResponse> diagnoseHardware(
            @RequestParam("image") MultipartFile image,
            @RequestParam(value = "audio", required = false) MultipartFile audio,
            @RequestParam(value = "audioMimeType", required = false) String audioMimeType,
            @RequestParam("symptom") String symptom,
            @RequestParam(value = "biosType", required = false) String biosType,
            @RequestParam(value = "sessionId", required = false) String sessionId) throws IOException {

        String base64Image = Base64.getEncoder().encodeToString(image.getBytes());
        byte[] audioBytes = audio != null ? audio.getBytes() : null;
        String result = diagnosisService.diagnoseMultimodal(base64Image, audioBytes, audioMimeType, symptom, biosType);
        return ResponseEntity.ok(new DiagnosisResponse(result));
    }
}
```

## Phase 6 — CameraView.tsx (기본)

```tsx
import { useRef, useState, useEffect } from 'react';

interface Props {
  onCapture: (dataUrl: string) => void;
}

export default function CameraView({ onCapture }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [streaming, setStreaming] = useState(false);

  const startCamera = async () => {
    // facingMode: 'environment' — 모바일에서 후면(PC 촬영용) 카메라 우선 사용
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    if (videoRef.current) videoRef.current.srcObject = stream;
    setStreaming(true);
  };

  const capture = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    onCapture(canvas.toDataURL('image/jpeg'));
  };

  // 컴포넌트 언마운트 시 스트림 정리 — 카메라 LED 계속 켜져 있는 문제 방지
  useEffect(() => {
    return () => {
      videoRef.current?.srcObject?.getTracks().forEach(t => t.stop());
    };
  }, []);

  return (
    <div className="camera-view">
      <video ref={videoRef} autoPlay playsInline muted />
      {!streaming
        ? <button onClick={startCamera}>카메라 켜기</button>
        : <button onClick={capture}>📸 촬영</button>
      }
    </div>
  );
}
```

---

## Phase 6 — useOpenCV.ts

```ts
import { useEffect, useState } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const cv: any;

export function useOpenCV(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof cv !== 'undefined' && cv.Mat) { setReady(true); return; }
    const script = document.createElement('script');
    script.src = '/opencv.js';
    script.async = true;
    // 2단계 비동기: script.onload 후 cv.onRuntimeInitialized 완료 시만 사용 가능
    script.onload = () => {
      cv['onRuntimeInitialized'] = () => setReady(true);
    };
    document.body.appendChild(script);
  }, []);

  return ready;
}
```

## Phase 7 — OpenCV 실시간 촬영 가이드 (CameraView.tsx 확장)

> **[!WARNING]** Mat 객체는 예외 발생 시에도 반드시 해제해야 합니다. JS GC는 WASM 힙을 회수하지 못하므로 반드시 `try/finally`로 `.delete()`를 보장하세요.

### guidance 상태 흐름

```
카메라 켜짐
    ↓
[CLAHE → Laplacian]  blurScore < 100  → 'stabilize' → "카메라를 고정해 주세요"
    ↓ 선명
[Canny → findContours]  감지 없음      → 'no_target' → "PC 내부를 향해주세요"
    ↓ 감지됨
[최대 컨투어 면적]  < 프레임의 5%      → 'too_far'   → "더 가까이 찍어주세요"
    ↓ 충분
[3프레임 연속 통과]                    → 'ready'     → "좋아요! 자동 촬영합니다"
```

### 반환 타입

```ts
type Guidance = 'stabilize' | 'no_target' | 'too_far' | 'ready';

interface FrameAnalysis {
  guidance: Guidance;
  guidanceText: string;
  qualityScore: number;      // 0~100
  blurScore: number;
  coverageRatio: number;
  isReadyToCapture: boolean;
}
```

### processFrame 구현

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const cv: any;

const BLUR_THRESHOLD      = 100;
const COVERAGE_MIN        = 0.05;
const READY_FRAMES_NEEDED = 3;

export function processFrame(
  videoEl: HTMLVideoElement,
  canvasEl: HTMLCanvasElement,
  readyCount: number,
): FrameAnalysis {
  const ctx = canvasEl.getContext('2d')!;
  ctx.drawImage(videoEl, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
  const frameArea = canvasEl.width * canvasEl.height;

  const src       = cv.matFromImageData(imageData);
  const gray      = new cv.Mat();
  const blurred   = new cv.Mat();
  const edges     = new cv.Mat();
  const contours  = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const lap       = new cv.Mat();
  const mean      = new cv.Mat();
  const stddev    = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // CLAHE는 실제 구현 시 useRef로 1회 생성 후 재사용, 언마운트 시 delete()
    const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    clahe.apply(gray, gray);
    clahe.delete();

    cv.Laplacian(gray, lap, cv.CV_32F);
    cv.meanStdDev(lap, mean, stddev);
    const blurScore = stddev.doubleAt(0, 0) ** 2;

    if (blurScore < BLUR_THRESHOLD) {
      return { guidance: 'stabilize', guidanceText: '카메라를 고정해 주세요',
               qualityScore: 0, blurScore, coverageRatio: 0, isReadyToCapture: false };
    }

    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 50, 150);
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    if (contours.size() === 0) {
      return { guidance: 'no_target', guidanceText: 'PC 내부를 향해주세요',
               qualityScore: 0, blurScore, coverageRatio: 0, isReadyToCapture: false };
    }

    let maxArea = 0;
    let maxIdx  = 0;
    for (let i = 0; i < contours.size(); i++) {
      const area = cv.contourArea(contours.get(i));
      if (area > maxArea) { maxArea = area; maxIdx = i; }
    }
    const coverageRatio = maxArea / frameArea;

    if (coverageRatio < COVERAGE_MIN) {
      return { guidance: 'too_far', guidanceText: '더 가까이 찍어주세요',
               qualityScore: 0, blurScore, coverageRatio, isReadyToCapture: false };
    }

    const sharpScore    = Math.min(blurScore / 500, 1.0);
    const coverageScore = Math.min(coverageRatio / 0.3, 1.0);
    const qualityScore  = Math.round((sharpScore * 0.5 + coverageScore * 0.5) * 100);

    for (let i = 0; i < contours.size(); i++) {
      const rect = cv.boundingRect(contours.get(i));
      if (rect.width < 60 || rect.height < 60) continue;
      ctx.strokeStyle = i === maxIdx ? '#3182f6' : '#05c46b';
      ctx.lineWidth   = i === maxIdx ? 3 : 1;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    }

    const isReadyToCapture = readyCount + 1 >= READY_FRAMES_NEEDED;
    return { guidance: 'ready', guidanceText: '좋아요!',
             qualityScore, blurScore, coverageRatio, isReadyToCapture };

  } finally {
    [src, gray, blurred, edges, contours, hierarchy, lap, mean, stddev].forEach(m => m.delete());
  }
}
```

---

## Phase 9 — ManualToolProvider.java

```java
@Component
public class ManualToolProvider {

    private final ManualRepository manualRepository;

    @Tool(description = "메인보드 모델명과 에러 코드로 제조사 매뉴얼에서 해결법을 검색합니다.")
    public String get_manual_info(
            @ToolParam(description = "제품 모델명, 예: ASUS-B760-PLUS") String model_name,
            @ToolParam(description = "에러 코드 또는 비프음 패턴, 예: 3long1short") String error_code) {

        return manualRepository.findByModelAndErrorCode(model_name, error_code)
            .map(ManualEntry::getSolution)
            .orElse("해당 모델의 매뉴얼 정보를 찾을 수 없습니다.");
    }
}
```

## Phase 9 — RepairAgent.java (Spring AI)

```java
@Service
@RequiredArgsConstructor
public class RepairAgent {

    private final ChatClient chatClient;
    private final ManualToolProvider manualTool;

    private static final String SYSTEM_PROMPT = """
        당신은 '옆집 컴공생' AI입니다.
        말투: 친근한 공대생처럼. 기술 근거는 정확하게.
        답변 형식: "여기[부품/프로세스]에 문제가 있는 것 같아요. 해결방법은 ~~ 입니다."
        증상에 관련 부품 모델명이 있으면 반드시 get_manual_info()를 먼저 호출할 것.
        """;

    public String diagnoseWithTools(String base64Image, String symptom) {
        return chatClient.prompt()
            .system(SYSTEM_PROMPT)
            .user(u -> u
                .text("증상: " + symptom)
                .media(MimeTypeUtils.IMAGE_JPEG,
                    new ByteArrayResource(Base64.getDecoder().decode(base64Image)))
            )
            .tools(ToolCallbacks.from(manualTool))  // Spring AI 1.x 공식 패턴
            .call()
            .content();
    }
}
// 참고: Spring AI 버전에 따라 .tools() 인자가 다를 수 있음
// 실제 사용 버전의 JavaDoc 확인 권장
```

---

## Phase 8 — AudioCapture.tsx (화면 없음 전용 — 오디오만 녹음)

> **[!NOTE]** PC가 완전히 켜지지 않아 카메라로 찍을 화면이 없는 경우 전용.
> 일반 비프음/팬소음 진단은 `VideoAnalysis.tsx`의 통합 촬영을 사용하세요.

> **[!WARNING]** iOS Safari는 `audio/webm`을 지원하지 않습니다.
> `MediaRecorder.isTypeSupported('audio/webm')` 분기로 `audio/mp4` 폴백 처리 필수.

```tsx
import { useRef, useState } from 'react';

interface Props {
  onAudioReady: (blob: Blob, mimeType: string) => void;
}

export default function AudioCapture({ onAudioReady }: Props) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef   = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);

  const start = async () => {
    chunksRef.current = [];
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,   // 비프음 보존: AEC 비활성화
        noiseSuppression: false,
        autoGainControl:  false,
      },
    });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = e => chunksRef.current.push(e.data);
    recorder.onstop = () => {
      onAudioReady(new Blob(chunksRef.current, { type: mimeType }), mimeType);
      stream.getTracks().forEach(t => t.stop());
    };
    recorder.start();
    recorderRef.current = recorder;
    setRecording(true);
  };

  const stop = () => {
    recorderRef.current?.stop();
    setRecording(false);
  };

  return (
    <div>
      <p style={{ fontSize: '0.9rem', color: '#666' }}>
        화면이 전혀 없고 소리만 들리는 경우 사용하세요.
      </p>
      {!recording
        ? <button onClick={start}>🎙️ 비프음 녹음 시작</button>
        : <button onClick={stop} style={{ color: 'red' }}>⏹️ 녹음 중지</button>
      }
    </div>
  );
}
```

---

## pom.xml 핵심 의존성

> **의존성 전략**: Phase 1~2는 Gemini REST API 직접 호출 (API Key만 필요).
> Phase 9에서 Spring AI MCP 툴 연동 시 `spring-ai-mcp-spring-boot-starter` 추가.
> Vertex AI starter는 GCP 계정 + 인증 필요 → **직접 REST 방식으로 통일**.

```xml
<!-- Web (REST 직접 호출 방식 — Phase 1~2) -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
</dependency>

<!-- Spring AI Core + MCP (Phase 9 이후) -->
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-core</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-mcp-spring-boot-starter</artifactId>
</dependency>

<!-- JPA + PostgreSQL (Phase 10) -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-jpa</artifactId>
</dependency>
<dependency>
    <groupId>org.postgresql</groupId>
    <artifactId>postgresql</artifactId>
</dependency>

<!-- Spring AI BOM (버전 관리 — dependencyManagement에 추가) -->
<!--
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.ai</groupId>
      <artifactId>spring-ai-bom</artifactId>
      <version>1.0.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
-->
```

## docker-compose.yml

```yaml
version: '3.8'
services:
  db:
    image: postgres:15
    environment:
      POSTGRES_DB: nextdoorcs
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"

  backend:
    build: ./backend
    ports:
      - "8080:8080"
    environment:
      GEMINI_API_KEY: ${GEMINI_API_KEY}
      SPRING_DATASOURCE_URL: jdbc:postgresql://db:5432/nextdoorcs
      SPRING_DATASOURCE_USERNAME: postgres
      SPRING_DATASOURCE_PASSWORD: password
    depends_on:
      - db
```

---

## Phase 11 — WebSocketConfig.java (STOMP 설정)

```java
@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    @Override
    public void configureMessageBroker(MessageBrokerRegistry config) {
        config.enableSimpleBroker("/topic");
        config.setApplicationDestinationPrefixes("/app");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws")
            .setAllowedOriginPatterns("*")
            .withSockJS();
    }
}
```

---

## Phase 11 — DiagnosisSession.java (세션 엔티티)

> 정본: `.claude/rules/data-model.md` — 여기에 중복 정의하지 않음. 구현 시 data-model.md를 참조할 것.

---

## Phase 11 — SessionController.java

```java
@RestController
@RequestMapping("/api/session")
@RequiredArgsConstructor
public class SessionController {

    private final SessionService sessionService;
    private final SimpMessagingTemplate messagingTemplate;

    // 세션 생성 (PWA: PWA_ONLY, Electron: LINKED)
    // 응답: sessionId + sessionType + authToken + shortCode + expiresAt
    @PostMapping("/create")
    public ResponseEntity<SessionInfoDto> createSession() {
        return ResponseEntity.ok(sessionService.create());
    }

    // PWA: QR 스캔 후 PWA_ONLY → LINKED 업그레이드. 기존 PWA 세션 폐기 후 호출
    @PostMapping("/{id}/upgrade")
    public ResponseEntity<SessionInfoDto> upgradeSession(
            @PathVariable String id,
            @RequestHeader("X-Session-Token") String token) {
        return ResponseEntity.ok(sessionService.upgrade(id, token));
    }

    // 세션 만료 연장 (+5분, 1회 한정)
    @PostMapping("/{id}/extend")
    public ResponseEntity<Map<String, String>> extendSession(@PathVariable String id) {
        String newExpiry = sessionService.extend(id);
        return ResponseEntity.ok(Map.of("expiresAt", newExpiry));
    }

    // Electron: 소프트웨어 스냅샷 제출
    @PostMapping("/{id}/software")
    public ResponseEntity<Void> submitSoftware(
            @PathVariable String id,
            @RequestBody SoftwareSnapshotRequest req) {
        sessionService.saveSoftwareSnapshot(id, req);
        messagingTemplate.convertAndSend("/topic/session/" + id, Map.of("event", "SW_READY"));
        sessionService.triggerDiagnosisIfReady(id);
        return ResponseEntity.ok().build();
    }

    // PWA: 하드웨어 프레임 제출 (LINKED 세션은 token 검증 필수)
    @PostMapping("/{id}/hardware")
    public ResponseEntity<Void> submitHardware(
            @PathVariable String id,
            @RequestHeader(value = "X-Session-Token", required = false) String token,
            @RequestBody HardwareFramesRequest req) {
        sessionService.saveHardwareFrames(id, token, req);
        messagingTemplate.convertAndSend("/topic/session/" + id, Map.of("event", "HW_READY"));
        sessionService.triggerDiagnosisIfReady(id);
        return ResponseEntity.ok().build();
    }

    // 세션 상태 폴링
    @GetMapping("/{id}/status")
    public ResponseEntity<Map<String, String>> getStatus(@PathVariable String id) {
        return ResponseEntity.ok(Map.of("status", sessionService.getStatus(id)));
    }
}

// 응답 DTO
public record SessionInfoDto(
    String sessionId,
    String sessionType,
    String authToken,
    String shortCode,
    String expiresAt   // ISO 8601
) {}
```

---

## Phase 11 — QRDisplay.tsx (Electron — QR 생성 + 스캔 대기)

```tsx
import { useEffect, useState } from 'react';
import QRCode from 'react-qr-code';
import { SessionInfo } from '../../types';

interface Props {
  onSessionReady: (sessionId: string) => void;
}

// Vite 환경변수: import.meta.env.VITE_* (CRA의 process.env.REACT_APP_* 아님)
const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';
const PWA_BASE = import.meta.env.VITE_PWA_URL ?? 'http://localhost:3000';

export default function QRDisplay({ onSessionReady }: Props) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus]   = useState('WAITING');

  useEffect(() => {
    fetch(`${API_BASE}/api/session/create`, { method: 'POST' })
      .then(r => r.json())
      .then((data: SessionInfo) => setSession(data));
  }, []);

  // PWA 스캔 감지: 1초 폴링 (WebSocket 연결 전 초기 대기)
  useEffect(() => {
    if (!session || status !== 'WAITING') return;
    const interval = setInterval(() => {
      fetch(`${API_BASE}/api/session/${session.sessionId}/status`)
        .then(r => r.json())
        .then(({ status: s }: { status: string }) => {
          setStatus(s);
          if (s !== 'WAITING') {
            clearInterval(interval);
            onSessionReady(session.sessionId);
          }
        });
    }, 1000);
    return () => clearInterval(interval);
  }, [session, status]);

  // QR: PWA URL + sessionId + authToken 인코딩 (token 없으면 하이재킹 위험)
  const qrValue = session
    ? `${PWA_BASE}/scan?session=${session.sessionId}&token=${session.authToken}`
    : '';

  return (
    <div className="qr-display">
      {session ? (
        <>
          <QRCode value={qrValue} size={200} />
          <p>모바일로 QR을 스캔해 하드웨어 진단을 시작하세요</p>
          <p>또는 단축 코드 수동 입력: <strong>{session.shortCode}</strong></p>
          <p className="status">상태: {status}</p>
        </>
      ) : (
        <p>세션 생성 중...</p>
      )}
    </div>
  );
}
```

---

## Phase 11 — QRScanner.tsx (PWA — QR 스캔 + 세션 참여)

```tsx
import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

interface Props {
  onSessionJoined: (sessionId: string) => void;
}

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';

// BarcodeDetector 미지원 시 jsQR 폴백 자동 적용
export default function QRScanner({ onSessionJoined }: Props) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number | null>(null);
  const [scanning, setScanning] = useState(false);

  const startScan = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    if (videoRef.current) videoRef.current.srcObject = stream;
    setScanning(true);
  };

  useEffect(() => {
    if (!scanning) return;

    const scan = () => {
      const video  = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        rafRef.current = requestAnimationFrame(scan);
        return;
      }
      const ctx = canvas.getContext('2d')!;
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);

      if (code) {
        const url       = new URL(code.data);
        const sessionId = url.searchParams.get('session');
        const token     = url.searchParams.get('token');
        if (sessionId && token) {
          video.srcObject?.getTracks().forEach(t => t.stop());
          if (rafRef.current) cancelAnimationFrame(rafRef.current);

          // PWA_ONLY → LINKED 업그레이드: 기존 PWA 세션 폐기 후 호출
          fetch(`${API_BASE}/api/session/${sessionId}/upgrade`, {
            method: 'POST',
            headers: { 'X-Session-Token': token },
          }).then(() => onSessionJoined(sessionId));
          return;
        }
      }
      rafRef.current = requestAnimationFrame(scan);
    };

    rafRef.current = requestAnimationFrame(scan);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      videoRef.current?.srcObject?.getTracks().forEach(t => t.stop());
    };
  }, [scanning]);

  return (
    <div className="qr-scanner">
      <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%' }} />
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      {!scanning && (
        <button onClick={startScan}>QR 코드 스캔으로 세션 연결</button>
      )}
    </div>
  );
}
```

---

## Phase 11 — useSessionSync.ts (WebSocket STOMP 구독 훅)

```ts
import { useEffect, useRef, useState, useCallback } from 'react';
import { Client } from '@stomp/stompjs';
import SockJS from 'sockjs-client';

interface SessionEvent {
  event: string;
  [key: string]: unknown;
}

// sessionId 기반 WebSocket 구독. 진단 완료 이벤트 수신.
export default function useSessionSync(sessionId: string | null): SessionEvent | null {
  const [event, setEvent]     = useState<SessionEvent | null>(null);
  const clientRef             = useRef<Client | null>(null);

  const connect = useCallback(() => {
    clientRef.current?.deactivate();

    const client = new Client({
      webSocketFactory: () => new SockJS('/ws'),
      onConnect: () => {
        client.subscribe(`/topic/session/${sessionId}`, msg => {
          setEvent(JSON.parse(msg.body) as SessionEvent);
        });
      },
      reconnectDelay: 3000,
    });
    client.activate();
    clientRef.current = client;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    connect();
    return () => { clientRef.current?.deactivate(); };
  }, [sessionId, connect]);

  return event;
}
```

---

## 백엔드 배포 — railway.json (Railway 자동 배포)

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "backend/Dockerfile"
  },
  "deploy": {
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 300,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

Railway Dashboard → New Project → Deploy from GitHub repo로 연결하면 `railway.json` 자동 감지. Variables 탭에 `GEMINI_API_KEY`, `GEMINI_MODEL`, `RATE_LIMIT_DAILY`, `ALLOWED_ORIGINS` 등록. `PORT`는 Railway가 자동 주입.
