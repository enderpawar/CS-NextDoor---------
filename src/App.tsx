import { useState, useEffect } from 'react';
import { useRuntimeMode } from './hooks/useRuntimeMode';
import { useSystemInfo } from './hooks/useSystemInfo';
import type { ClipboardImage, HypothesesResponse } from './types';
import ElectronDashboard from './components/desktop/ElectronDashboard';
import { generateHypotheses } from './api/diagnosisApi';
import type { EventLog, ProcessData } from './types/electron';
import { Aperture, Camera, Link2, Mic, ScanLine, ShieldCheck, Sparkles, Waves } from 'lucide-react';
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
        <div className="nd-pwa-shell">
          <header className="nd-pwa-topbar animate-fade-in-down">
            <div className="nd-pwa-brand-block">
              <div className="nd-pwa-brand-mark" aria-hidden="true">
                <ScanLine size={20} />
              </div>
              <div>
                <p className="nd-pwa-overline">옆집 컴공생 모바일 진단</p>
                <h1 className="nd-pwa-title">PC 촬영 진단</h1>
              </div>
            </div>
            <span className="nd-status-pill neutral">
              {mode === 'pwa-session' ? 'Electron 연결됨' : '독립 진단'}
            </span>
          </header>

          <main className="nd-pwa-main">
            <section className="nd-pwa-diagnostic-stage animate-spring-in" aria-label="모바일 하드웨어 진단">
              <div className="nd-pwa-viewfinder">
                <div className="nd-pwa-viewfinder-top">
                  <span className="nd-pwa-live-dot">카메라 대기</span>
                  <span>품질 검사 준비</span>
                </div>
                <div className="nd-pwa-camera-status">
                  <span>촬영 품질</span>
                  <strong>91%</strong>
                </div>

                <div className="nd-pwa-scan-grid" aria-hidden="true" />
                <div className="nd-pwa-roi-frame" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <div className="nd-pwa-target-box nd-pwa-target-fan">
                  <span>팬 영역</span>
                  <strong>82%</strong>
                </div>
                <div className="nd-pwa-target-box nd-pwa-target-board">
                  <span>메인보드</span>
                  <strong>준비됨</strong>
                </div>
                <div className="nd-pwa-focus-ring" aria-hidden="true" />

                <div className="nd-pwa-viewfinder-bottom">
                  <div>
                    <span>초점</span>
                    <strong>양호</strong>
                  </div>
                  <div>
                    <span>포함률</span>
                    <strong>73%</strong>
                  </div>
                  <div>
                    <span>조도</span>
                    <strong>안정</strong>
                  </div>
                </div>
                <div className="nd-pwa-capture-dock" aria-label="촬영 상태">
                  <button className="nd-pwa-shutter" type="button" aria-label="진단 프레임 캡처">
                    <Camera size={26} />
                  </button>
                  <div>
                    <span>촬영 전 확인</span>
                    <strong>전송 전 로컬 품질 검사</strong>
                  </div>
                </div>
              </div>

              <aside className="nd-pwa-control-panel">
                <p className="nd-pwa-hero-eyebrow">카메라·비프음 진단</p>
                <h2>PC 내부 상태를 촬영하고 진단 가능한 근거만 보냅니다.</h2>
                <p>
                  초점, 조도, 부품 포함률을 먼저 확인한 뒤 팬, 메인보드, LED처럼 원인 판단에 필요한 장면만 정리합니다.
                </p>

                <div className="nd-pwa-action-row" aria-label="진단 입력 도구">
                  <button className="nd-pwa-icon-button primary" type="button" aria-label="카메라 촬영 시작">
                    <Camera size={22} />
                  </button>
                  <button className="nd-pwa-icon-button" type="button" aria-label="비프음 녹음">
                    <Mic size={21} />
                  </button>
                  <button className="nd-pwa-icon-button" type="button" aria-label="세션 연결">
                    <Link2 size={21} />
                  </button>
                </div>

                <div className="nd-pwa-quality-stack">
                  <div className="nd-pwa-session-card">
                    <span>진단 준비도</span>
                    <strong>카메라 · 오디오 · 세션 대기</strong>
                  </div>
                  <div className="nd-pwa-quality-row">
                    <span><Aperture size={15} /> 초점</span>
                    <strong>91</strong>
                  </div>
                  <div className="nd-pwa-meter"><span style={{ width: '91%' }} /></div>
                  <div className="nd-pwa-quality-row">
                    <span><ScanLine size={15} /> 대상 포함률</span>
                    <strong>73</strong>
                  </div>
                  <div className="nd-pwa-meter"><span style={{ width: '73%' }} /></div>
                  <div className="nd-pwa-quality-row">
                    <span><Waves size={15} /> 프레임 변화</span>
                    <strong>42</strong>
                  </div>
                  <div className="nd-pwa-meter"><span style={{ width: '42%' }} /></div>
                </div>
              </aside>
            </section>

            <section className="nd-pwa-signal-strip animate-fade-in-up delay-150" aria-label="진단 상태">
              <article>
                <Sparkles size={18} />
                <div>
                  <span>프레임 선별</span>
                  <strong>상위 5개 프레임 선별 예정</strong>
                </div>
              </article>
              <article>
                <ShieldCheck size={18} />
                <div>
                  <span>개인정보</span>
                  <strong>로컬 품질 평가 후 전송</strong>
                </div>
              </article>
              <article>
                <Link2 size={18} />
                <div>
                  <span>세션</span>
                  <strong>{mode === 'pwa-session' ? 'Electron 데이터 결합' : '모바일 단독 모드'}</strong>
                </div>
              </article>
            </section>

            {mode === 'pwa-standalone' && (
              <div className="nd-pwa-warning animate-fade-in-up delay-300">
                SW 데이터 없이 분석 중입니다. 독립 모드에서는 정확도가 제한될 수 있어요.
              </div>
            )}

            <section className="nd-pwa-card-grid">
              <article className="nd-pwa-card animate-fade-in-up delay-150">
                <span className="nd-pwa-card-label">01</span>
                <h3>촬영 품질 평가</h3>
                <p>Laplacian blur, 밝기, edge density로 사용할 수 있는 프레임인지 먼저 판단합니다.</p>
              </article>
              <article className="nd-pwa-card animate-fade-in-up delay-300">
                <span className="nd-pwa-card-label">02</span>
                <h3>ROI 후보 표시</h3>
                <p>Contour와 영역 비율을 이용해 팬, 보드, LED처럼 확인할 위치를 화면 위에 표시합니다.</p>
              </article>
              <article className="nd-pwa-card animate-fade-in-up delay-400">
                <span className="nd-pwa-card-label">03</span>
                <h3>변화 기반 전송</h3>
                <p>히스토그램 변화가 있는 순간만 선별해 중복 프레임과 불필요한 API 호출을 줄입니다.</p>
              </article>
            </section>
          </main>
        </div>
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
