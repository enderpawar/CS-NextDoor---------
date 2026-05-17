import { useState, useEffect } from 'react';
import { useRuntimeMode } from './hooks/useRuntimeMode';
import { useSystemInfo } from './hooks/useSystemInfo';
import type { ClipboardImage, HypothesesResponse } from './types';
import ElectronDashboard from './components/desktop/ElectronDashboard';
import LiveGuideMode from './components/mobile/LiveGuideMode';
import { generateHypotheses } from './api/diagnosisApi';
import type { EventLog, ProcessData } from './types/electron';
import './styles/tokens.css';
import './styles/global.css';
import './styles/animations.css';


const CPU_HISTORY_MAX = 60;
const INTRO_TRANSITION_MS = 820;

export default function App() {
  const mode = useRuntimeMode();
  const sysInfo = useSystemInfo();
  const [introVisible, setIntroVisible] = useState(true);
  const [introLeaving, setIntroLeaving] = useState(false);
  const [symptom, setSymptom] = useState('');
  const [clipboardImage, setClipboardImage] = useState<ClipboardImage | null>(null);

  const [cpuHistory, setCpuHistory] = useState<number[]>([]);

  // Phase 5: 진단 플로우 상태
  const [diagnosisResponse, setDiagnosisResponse] = useState<HypothesesResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [eventLogs, setEventLogs] = useState<EventLog[]>([]);
  const [processData, setProcessData] = useState<ProcessData | null>(null);

  // CPU 사용률 히스토리 — 실시간 꺾은선 그래프용
  useEffect(() => {
    if (sysInfo?.cpu.usage === undefined) return;
    setCpuHistory(prev => {
      const next = [...prev, sysInfo.cpu.usage];
      return next.length > CPU_HISTORY_MAX ? next.slice(-CPU_HISTORY_MAX) : next;
    });
  }, [sysInfo?.cpu.usage]);

  // Phase 4 이벤트 로그 수집 — HypothesisTracker의 패턴 분석에 전달
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    api.getEventLogs().then(setEventLogs).catch(() => {/* 수집 실패는 무시 */});
    api.getTopProcesses().then(setProcessData).catch(() => {/* 수집 실패는 무시 */});
  }, []);

  // Phase 2: 클립보드 이미지 붙여넣기
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (!imageItem) return;

    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      setClipboardImage({ dataUrl, file });
    };
    reader.readAsDataURL(file);
  };

  const clearImage = () => setClipboardImage(null);

  const enterApp = () => {
    if (introLeaving) return;
    setIntroLeaving(true);
    window.setTimeout(() => setIntroVisible(false), INTRO_TRANSITION_MS);
  };

  // Phase 5: 진단 요청 — 가설 생성
  const handleDiagnose = async () => {
    if (!symptom.trim()) return;
    setIsLoading(true);
    setApiError(null);
    setDiagnosisResponse(null);

    try {
      const base64Image = clipboardImage?.dataUrl.includes(',')
        ? clipboardImage.dataUrl.split(',')[1]
        : undefined;

      const systemSnapshot: Record<string, unknown> = sysInfo
        ? {
            cpu: { usage: sysInfo.cpu.usage, temperature: sysInfo.cpu.temperature },
            memory: { used: sysInfo.memory.used, total: sysInfo.memory.total },
            gpu: sysInfo.gpu,
          }
        : {};

      const response = await generateHypotheses({
        symptom: symptom.trim(),
        clipboardImage: base64Image,
        systemSnapshot,
      });

      setDiagnosisResponse(response);
    } catch (e) {
      setApiError((e as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setDiagnosisResponse(null);
    setApiError(null);
    setSymptom('');
    setClipboardImage(null);
  };

  return (
    <div className={`app-root mode-${mode} ${introVisible ? 'intro-active' : 'intro-entered'} ${introLeaving ? 'intro-leaving' : ''}`}>
      {introVisible && (
        <button
          type="button"
          className={`nd-intro-sequence ${introLeaving ? 'is-leaving' : ''}`}
          onClick={enterApp}
          aria-label="인트로를 닫고 진단 화면으로 이동"
        >
          <div className="nd-intro-frame">
            <div className="nd-intro-header">
              <span>NextDoor CS</span>
              <span>AI PC Diagnosis</span>
            </div>
            <div className="nd-intro-core">
              <span className="nd-intro-orbit nd-intro-orbit-one" />
              <span className="nd-intro-orbit nd-intro-orbit-two" />
              <span className="nd-intro-reticle" />
              <span className="nd-intro-mark">N</span>
              <div className="nd-intro-title">
                <p>옆집 컴공생</p>
                <strong>PC 문제를 바로 읽는 AI 진단</strong>
              </div>
            </div>
            <div className="nd-intro-log">
              <span>System</span>
              <span>Vision</span>
              <span>Signal</span>
              <span>Ready</span>
            </div>
            <div className="nd-intro-progress"><span /></div>
            <div className="nd-intro-cta">
              <span>Click to enter</span>
              <span aria-hidden="true">→</span>
            </div>
          </div>
        </button>
      )}

      <div className="nd-app-stage">
        {/* ── PWA 모드 — Camera-First 진입 ── */}
        {mode !== 'electron' && (
          <LiveGuideMode isStandalone={mode === 'pwa-standalone'} />
        )}

        {/* ── Electron 모드 — 3컬럼 대시보드 ── */}
        {mode === 'electron' && (
          <ElectronDashboard
            sysInfo={sysInfo}
            cpuHistory={cpuHistory}
            symptom={symptom}
            clipboardImage={clipboardImage}
            isLoading={isLoading}
            apiError={apiError}
            processData={processData}
            eventLogs={eventLogs}
            diagnosisResponse={diagnosisResponse}
            onSymptomChange={setSymptom}
            onPaste={handlePaste}
            onDiagnose={handleDiagnose}
            onClearImage={clearImage}
            onReset={handleReset}
          />
        )}
      </div>
    </div>
  );
}
