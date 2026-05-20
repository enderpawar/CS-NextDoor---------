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
const INTRO_TRANSITION_MS = 820;

// 인트로 로고 — 오비탈 링 + 글로우로 강화
function IntroLogo() {
  const size = 96;
  return (
    <div className="nd-intro-logo-stage" style={{ width: size * 2.2, height: size * 2.2 }}>
      <div className="nd-intro-orbit-ring nd-intro-orbit-ring--outer" aria-hidden="true"/>
      <div className="nd-intro-orbit-ring nd-intro-orbit-ring--inner" aria-hidden="true"/>
      <div className="nd-intro-orbit-dot nd-intro-orbit-dot--one" aria-hidden="true"/>
      <div className="nd-intro-orbit-dot nd-intro-orbit-dot--two" aria-hidden="true"/>
      <div className="nd-intro-logo-glow" aria-hidden="true"/>
      <div className="nd-intro-logo-tile" style={{
        width: size, height: size, borderRadius: size * 0.28,
        background: 'linear-gradient(155deg, oklch(0.56 0.15 245) 0%, oklch(0.42 0.16 248) 100%)',
        display: 'grid', placeItems: 'center', position: 'relative', overflow: 'hidden',
        boxShadow: `0 18px 40px -10px oklch(0.56 0.15 245 / 0.55), 0 0 0 1px rgba(255,255,255,0.08) inset`,
      }}>
        <div style={{
          width: size * 0.56, height: size * 0.42, borderRadius: size * 0.1,
          background: 'rgba(255,255,255,0.12)',
          border: '2px solid rgba(255,255,255,0.92)',
          display: 'grid', placeItems: 'center',
        }}>
          <div style={{ width: size * 0.22, height: size * 0.05, borderRadius: size * 0.03, background: '#fff' }}/>
        </div>
        <div style={{
          position: 'absolute', right: size * 0.14, bottom: size * 0.14,
          width: size * 0.2, height: size * 0.2, borderRadius: '50%',
          background: 'oklch(0.78 0.13 195)',
          boxShadow: `0 0 0 ${size * 0.04}px oklch(0.56 0.15 245)`,
        }}/>
        <span className="nd-intro-logo-sheen" aria-hidden="true"/>
      </div>
    </div>
  );
}

// 한 글자씩 카스케이드 등장 — Pretendard 두께 강조
function IntroLetters({ text, baseDelay = 0 }: { text: string; baseDelay?: number }) {
  return (
    <>
      {Array.from(text).map((ch, i) => (
        <span
          key={`${ch}-${i}`}
          className="nd-intro-char"
          style={{ animationDelay: `${baseDelay + i * 55}ms` }}
        >
          {ch === ' ' ? ' ' : ch}
        </span>
      ))}
    </>
  );
}

export default function App() {
  const mode = useRuntimeMode();
  const sysInfo = useSystemInfo();
  const [introVisible, setIntroVisible] = useState(() => {
    try {
      return !sessionStorage.getItem('nd-intro-seen');
    } catch {
      return true;
    }
  });
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
    try {
      sessionStorage.setItem('nd-intro-seen', '1');
    } catch {}
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
          <div className="nd-intro-grid" aria-hidden="true"/>
          <div className="nd-intro-aurora nd-intro-aurora--one" aria-hidden="true"/>
          <div className="nd-intro-aurora nd-intro-aurora--two" aria-hidden="true"/>
          <div className="nd-intro-aurora nd-intro-aurora--three" aria-hidden="true"/>

          <div className="nd-intro-stack">
            <div className="nd-intro-eyebrow">
              <span className="nd-intro-eyebrow-dot" aria-hidden="true"/>
              NEXTDOOR · CS DIAGNOSTIC
            </div>
            <IntroLogo />
            <div className="nd-intro-wordmark" aria-label="옆집. 컴공생">
              <span className="nd-intro-wordmark-line">
                <IntroLetters text="옆집" baseDelay={420}/>
                <span
                  className="nd-intro-char nd-intro-dot"
                  style={{ animationDelay: `${420 + 2 * 55}ms` }}
                >
                  .
                </span>
                <span className="nd-intro-char nd-intro-space" style={{ animationDelay: `${420 + 3 * 55}ms` }}> </span>
                <IntroLetters text="컴공생" baseDelay={420 + 4 * 55}/>
              </span>
              <span className="nd-intro-wordmark-sheen" aria-hidden="true"/>
            </div>
            <p className="nd-intro-tagline">수리기사 부르기 전, 옆집 컴공생이 먼저 봅니다</p>
            <div className="nd-intro-progress"><span /></div>
            <div className="nd-intro-cta">
              <span className="nd-intro-cta-glow" aria-hidden="true"/>
              <span>탭하여 시작하기</span>
              <span aria-hidden="true">→</span>
            </div>
          </div>
        </button>
      )}

      <div className="nd-app-stage">
        {/* ── PWA 모드 — 랜딩 → 진단 모드 선택 ── */}
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
    </div>
  );
}
