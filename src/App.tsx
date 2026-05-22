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

// 인트로 마스코트 — 캐릭터 + 떠다니는 스파클 입자
const INTRO_SPARKLES: Array<{
  shape: 'dot' | 'star' | 'diamond' | 'plus';
  size: number;
  top: string;
  left: string;
  delay: number;
  drift: number;
  hue: 'mint' | 'indigo' | 'lilac' | 'sky';
}> = [
  { shape: 'star',    size: 14, top: '6%',  left: '14%', delay: 320, drift: 7,  hue: 'mint'   },
  { shape: 'dot',     size: 8,  top: '12%', left: '78%', delay: 380, drift: 6,  hue: 'indigo' },
  { shape: 'diamond', size: 10, top: '32%', left: '4%',  delay: 460, drift: 9,  hue: 'sky'    },
  { shape: 'plus',    size: 12, top: '8%',  left: '52%', delay: 520, drift: 5,  hue: 'lilac'  },
  { shape: 'dot',     size: 6,  top: '46%', left: '92%', delay: 580, drift: 8,  hue: 'mint'   },
  { shape: 'star',    size: 11, top: '70%', left: '88%', delay: 640, drift: 6,  hue: 'indigo' },
  { shape: 'diamond', size: 8,  top: '82%', left: '8%',  delay: 700, drift: 7,  hue: 'lilac'  },
  { shape: 'dot',     size: 10, top: '64%', left: '20%', delay: 760, drift: 9,  hue: 'sky'    },
  { shape: 'plus',    size: 9,  top: '40%', left: '72%', delay: 820, drift: 5,  hue: 'mint'   },
  { shape: 'star',    size: 8,  top: '92%', left: '54%', delay: 880, drift: 6,  hue: 'indigo' },
  { shape: 'dot',     size: 5,  top: '24%', left: '30%', delay: 940, drift: 4,  hue: 'sky'    },
];

function Sparkle({ shape }: { shape: 'dot' | 'star' | 'diamond' | 'plus' }) {
  if (shape === 'star') {
    return (
      <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
        <path d="M12 2.5c.45 3.6 2.4 5.55 6 6-3.6.45-5.55 2.4-6 6-.45-3.6-2.4-5.55-6-6 3.6-.45 5.55-2.4 6-6z" fill="currentColor"/>
      </svg>
    );
  }
  if (shape === 'diamond') {
    return (
      <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
        <path d="M12 2l5 10-5 10-5-10z" fill="currentColor" opacity="0.85"/>
      </svg>
    );
  }
  if (shape === 'plus') {
    return (
      <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
        <path d="M12 3v18M3 12h18" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
      </svg>
    );
  }
  return <span className="nd-intro-sparkle-dot" />;
}

function IntroMascot() {
  return (
    <div className="nd-intro-mascot-stage">
      <div className="nd-intro-mascot-glow" aria-hidden="true" />
      <div className="nd-intro-mascot-ring nd-intro-mascot-ring--outer" aria-hidden="true" />
      <div className="nd-intro-mascot-ring nd-intro-mascot-ring--inner" aria-hidden="true" />
      <div className="nd-intro-sparkles" aria-hidden="true">
        {INTRO_SPARKLES.map((s, i) => (
          <span
            key={i}
            className={`nd-intro-sparkle nd-intro-sparkle--${s.shape} nd-intro-sparkle--${s.hue}`}
            style={{
              top: s.top,
              left: s.left,
              width: s.size,
              height: s.size,
              animationDelay: `${s.delay}ms, ${s.delay + 900}ms`,
              ['--drift' as string]: `${s.drift}px`,
            }}
          >
            <Sparkle shape={s.shape} />
          </span>
        ))}
      </div>
      <img
        className="nd-intro-mascot-img"
        src="/brand-mascot.png"
        alt=""
        draggable={false}
      />
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
            <span className="nd-intro-eyebrow">
              <span className="nd-intro-eyebrow-dot" aria-hidden="true" />
              컴공생을 깨우는 중
            </span>
            <IntroMascot />
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
            </div>
            <p className="nd-intro-tagline">수리기사 부르기 전, 옆집에 한 번 물어보세요</p>
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
