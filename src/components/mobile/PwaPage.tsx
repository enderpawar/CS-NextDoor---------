/**
 * Phase 6 — PWA 랜딩 페이지
 *
 * 독립 모드: URL에 ?session= 파라미터 없음 → SW 데이터 없음 경고 표시
 * 세션 모드: ?session= 파라미터 있음 → Electron 연결됨
 *
 * iOS Safari: 카메라 권한 유지를 위해 페이지 이동 금지.
 * 기능 전환은 state 기반 (페이지 이동 없음).
 */

/**
 * Phase 6 — PWA 랜딩 페이지
 *
 * 독립 모드: URL에 ?session= 파라미터 없음 → SW 데이터 없음 경고 표시
 * 세션 모드: ?session= 파라미터 있음 → Electron 연결됨
 *
 * iOS Safari: 카메라 권한 유지를 위해 페이지 이동 금지.
 * 기능 전환은 state 기반 (페이지 이동 없음).
 *
 * Phase 8 추가: 오디오 진단 뷰 (BiosTypeSelector + AudioCapture)
 */

import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Cpu,
  Mic,
  Monitor,
  PlugZap,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  WifiOff,
} from 'lucide-react';
import type { BiosType } from '../../types';
import '../../styles/mobile.css';
import LiveGuideMode    from './LiveGuideMode';
import BiosTypeSelector from './BiosTypeSelector';
import AudioCapture     from './AudioCapture';

type PwaView = 'home' | 'live-guide' | 'audio-capture';
type DiagnosticPath = 'no-boot' | 'screen-guide' | 'beep' | 'windows-running';

interface PathOption {
  id: DiagnosticPath;
  title: string;
  desc: string;
  action: string;
  icon: typeof Monitor;
  view?: Exclude<PwaView, 'home'>;
  evidence: string[];
}

const PATH_OPTIONS: PathOption[] = [
  {
    id: 'no-boot',
    title: '전원이 켜지지만 화면이 안 나와요',
    desc: '모니터 신호, RAM 재장착, BIOS 진입 가능 여부를 순서대로 확인합니다.',
    action: '카메라 가이드 시작',
    icon: Monitor,
    view: 'live-guide',
    evidence: ['전원 LED 상태', '모니터 입력 소스', '메인보드/그래픽카드 화면'],
  },
  {
    id: 'beep',
    title: '부팅할 때 비프음이 들려요',
    desc: 'BIOS 제조사와 비프음 패턴을 묶어서 RAM, 그래픽, 메인보드 가능성을 좁힙니다.',
    action: '비프음 녹음',
    icon: Mic,
    view: 'audio-capture',
    evidence: ['BIOS 제조사', '비프음 길이와 반복', '부팅 직후 녹음'],
  },
  {
    id: 'screen-guide',
    title: 'BIOS나 설치 화면에서 막혔어요',
    desc: '화면을 비추면 부팅 메뉴, Secure Boot, Windows 설치 단계를 안내합니다.',
    action: '화면 가이드 시작',
    icon: Camera,
    view: 'live-guide',
    evidence: ['현재 화면 전체', '오류 문구', '키보드 조작 가능 여부'],
  },
  {
    id: 'windows-running',
    title: 'Windows는 켜지지만 느리거나 불안정해요',
    desc: 'PWA에서는 증거 수집을 안내하고, 데스크톱 앱 연결 시 이벤트 로그와 프로세스를 함께 봅니다.',
    action: '수집 순서 보기',
    icon: Activity,
    evidence: ['작업 관리자 화면', '오류 팝업', '발생 시점과 반복 조건'],
  },
];

const WORKFLOW_STEPS = [
  { title: '상태 분류', desc: '부팅 가능 여부와 증상을 먼저 고릅니다.' },
  { title: '증거 수집', desc: '카메라, 마이크, 화면 정보를 필요한 만큼만 받습니다.' },
  { title: '가설 좁히기', desc: '하드웨어/설정/OS 원인을 분리합니다.' },
  { title: '다음 조치', desc: '자가 조치와 기사 상담 기준을 나눕니다.' },
];

interface Props {
  isStandalone: boolean;  // URL에 ?session= 없음 (PC 부팅 불가 진입)
}

export default function PwaPage({ isStandalone }: Props) {
  const [view,     setView]     = useState<PwaView>('home');
  const [biosType, setBiosType] = useState<BiosType | null>(null);
  const [selectedPath, setSelectedPath] = useState<DiagnosticPath>('no-boot');

  const selectedOption = useMemo<PathOption>(
    () => PATH_OPTIONS.find(option => option.id === selectedPath) ?? PATH_OPTIONS[0]!,
    [selectedPath],
  );

  const startSelectedPath = () => {
    if (selectedOption.view) {
      setView(selectedOption.view);
    }
  };

  if (view === 'live-guide') {
    return <LiveGuideMode isStandalone={isStandalone} />;
  }

  if (view === 'audio-capture') {
    return (
      <div className="nd-pwa-page">
        <div className="nd-pwa-header">
          <button
            type="button"
            onClick={() => setView('home')}
            className="nd-pwa-back-button"
            aria-label="홈으로"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="nd-pwa-header-text">
            <span className="nd-pwa-app-name">비프음 진단</span>
            <span className="nd-pwa-app-sub">PC 부팅 오류 코드 분석</span>
          </div>
        </div>

        <div className="nd-pwa-mode-card">
          <BiosTypeSelector selected={biosType} onSelect={setBiosType} />
        </div>

        <div className="nd-pwa-mode-card">
          <AudioCapture biosType={biosType} symptom="부팅 시 비프음 패턴 분석" />
        </div>
      </div>
    );
  }

  return (
    <div className="nd-pwa-page">
      <div className="nd-pwa-header">
        <div className="nd-pwa-logo-mark" aria-hidden="true">
          <Cpu size={20} />
        </div>
        <div className="nd-pwa-header-text">
          <span className="nd-pwa-app-name">NextDoor CS</span>
          <span className="nd-pwa-app-sub">PWA PC 진단 콘솔</span>
        </div>
      </div>

      {isStandalone && (
        <div className="nd-standalone-warn" role="alert">
          <WifiOff size={18} aria-hidden="true" />
          <span>
            더 정확한 진단이 필요하다면 컴퓨터에서 만나요. 지금은 휴대폰 카메라와 마이크로 부팅 전 하드웨어 단서를 먼저 확인할 수 있습니다.
          </span>
        </div>
      )}

      <section className="nd-pwa-hero-panel" aria-labelledby="pwa-main-title">
        <div>
          <span className="nd-pwa-mode-label">Triage first workflow</span>
          <h1 id="pwa-main-title">PC가 어떤 상태인지 먼저 고르세요.</h1>
          <p>
            진단은 기능을 고르는 일이 아니라, 증상을 분류하고 필요한 증거를 좁히는 흐름이어야 합니다.
            PWA는 부팅 불가 상황에서도 카메라와 마이크로 하드웨어 단서를 바로 수집합니다.
          </p>
        </div>
        <div className="nd-pwa-hero-status" aria-label="진단 범위">
          <span><Smartphone size={16} /> PWA 우선</span>
          <span><ShieldCheck size={16} /> 권한 최소 요청</span>
          <span><PlugZap size={16} /> 부팅 불가 대응</span>
        </div>
      </section>

      <section className="nd-pwa-workflow-strip" aria-label="진단 워크플로우">
        {WORKFLOW_STEPS.map((step, index) => (
          <article key={step.title} className={index === 0 ? 'active' : ''}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <strong>{step.title}</strong>
            <p>{step.desc}</p>
          </article>
        ))}
      </section>

      <main className="nd-pwa-diagnosis-layout">
        <section className="nd-pwa-path-list" aria-labelledby="path-list-title">
          <div className="nd-pwa-section-head">
            <span className="nd-pwa-mode-label">증상 선택</span>
            <h2 id="path-list-title">가장 가까운 상태</h2>
          </div>
          {PATH_OPTIONS.map(option => {
            const Icon = option.icon;
            const isSelected = selectedPath === option.id;
            return (
              <button
                key={option.id}
                type="button"
                className={`nd-pwa-path-button${isSelected ? ' selected' : ''}`}
                onClick={() => setSelectedPath(option.id)}
                aria-pressed={isSelected}
              >
                <span className="nd-pwa-path-icon"><Icon size={20} /></span>
                <span className="nd-pwa-path-copy">
                  <strong>{option.title}</strong>
                  <small>{option.desc}</small>
                </span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            );
          })}
        </section>

        <aside className="nd-pwa-action-panel" aria-labelledby="recommended-action-title">
          <div className="nd-pwa-section-head">
            <span className="nd-pwa-mode-label">권장 경로</span>
            <h2 id="recommended-action-title">{selectedOption.title}</h2>
            <p>{selectedOption.desc}</p>
          </div>

          <div className="nd-pwa-evidence-box">
            <div className="nd-pwa-evidence-title">
              <ClipboardCheck size={18} />
              먼저 확보할 증거
            </div>
            <ul>
              {selectedOption.evidence.map(item => (
                <li key={item}>
                  <CheckCircle2 size={15} />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          {selectedOption.view ? (
            <button
              type="button"
              className="nd-pwa-primary-action"
              onClick={startSelectedPath}
            >
              {selectedOption.action}
              <ChevronRight size={18} />
            </button>
          ) : (
            <div className="nd-pwa-offline-action">
              <AlertTriangle size={18} />
              Windows 실행 중 진단은 데스크톱 앱 연결 시 가장 정확합니다. 지금은 화면과 오류 문구를 촬영해 증거를 모아두세요.
            </div>
          )}

          <button
            type="button"
            className="nd-pwa-secondary-action"
            onClick={() => setSelectedPath('no-boot')}
          >
            <RotateCcw size={16} />
            처음 상태로
          </button>
        </aside>
      </main>

      <p className="nd-pwa-footnote">
        카메라와 마이크 권한은 해당 진단을 시작할 때만 요청합니다. HTTPS 환경 또는 localhost에서 동작합니다.
      </p>
    </div>
  );
}
