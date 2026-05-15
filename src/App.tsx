import { useState, useEffect } from 'react';
import { useRuntimeMode } from './hooks/useRuntimeMode';
import { useSystemInfo } from './hooks/useSystemInfo';
import type { ClipboardImage, HypothesesResponse } from './types';
import ElectronDashboard from './components/desktop/ElectronDashboard';
import PwaPage from './components/mobile/PwaPage';
import { generateHypotheses } from './api/diagnosisApi';
import type { EventLog, ProcessData } from './types/electron';
import './styles/tokens.css';
import './styles/global.css';
import './styles/animations.css';


const CPU_HISTORY_MAX = 60;

export default function App() {
  const mode = useRuntimeMode();
  const sysInfo = useSystemInfo();
  const [introDone, setIntroDone] = useState(false);
  const [symptom, setSymptom] = useState('');
  const [clipboardImage, setClipboardImage] = useState<ClipboardImage | null>(null);

  const [cpuHistory, setCpuHistory] = useState<number[]>([]);

  // Phase 5: 진단 플로우 상태
  const [diagnosisResponse, setDiagnosisResponse] = useState<HypothesesResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [eventLogs, setEventLogs] = useState<EventLog[]>([]);
  const [processData, setProcessData] = useState<ProcessData | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setIntroDone(true), 3150);
    return () => window.clearTimeout(timer);
  }, []);

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
    <div className={`app-root mode-${mode}`}>
      {!introDone && (
        <div className="nd-intro-sequence" aria-hidden="true">
          <div className="nd-intro-frame">
            <div className="nd-intro-header">
              <span>PC DIAGNOSIS</span>
              <span>NEXTDOOR CS</span>
            </div>
            <div className="nd-intro-core">
              <span className="nd-intro-reticle" />
              <span className="nd-intro-mark">N</span>
              <div className="nd-intro-title">
                <p>옆집 컴공생</p>
                <strong>AI PC 진단을 준비하고 있습니다</strong>
              </div>
            </div>
            <div className="nd-intro-log">
              <span>01. 시스템 상태 확인</span>
              <span>02. 이벤트 로그 연결</span>
              <span>03. 카메라·마이크 진단 대기</span>
              <span>04. 증상 입력 화면 준비</span>
            </div>
            <div className="nd-intro-progress"><span /></div>
          </div>
        </div>
      )}

      {/* ── PWA 모드 ── */}
      {mode !== 'electron' && (
        <PwaPage isStandalone={mode === 'pwa-standalone'} />
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
  );
}
