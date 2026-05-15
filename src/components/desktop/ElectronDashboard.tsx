import { useEffect, useRef, useState } from 'react';
import type { ClipboardEventHandler } from 'react';
import type { ClipboardImage, HypothesesResponse, Hypothesis } from '../../types';
import type { EventLog, ProcessData, SystemSnapshot } from '../../types/electron';
import ProcessList from './ProcessList';
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Cpu,
  History,
  Link2,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

type HypoStatus = 'idle' | 'trying' | 'checking' | 'done' | 'failed';
type ActiveTab = 'diagnose' | 'process' | 'events';
type StepStatus = 'locked' | 'idle' | 'active' | 'done' | 'failed';
type ReproState = 'idle' | 'baseline' | 'reproducing' | 'done';
type ChatMsg =
  | { kind: 'user'; text: string }
  | { kind: 'ai-hypo'; response: HypothesesResponse }
  | { kind: 'error'; text: string };

const WORKFLOW_STEPS = [
  { num: 1, label: '증상 입력', sublabel: '시스템 스냅샷 수집' },
  { num: 2, label: '가설 추적', sublabel: 'A · B · C 가설 시도' },
  { num: 3, label: '재현 모드', sublabel: '베이스라인 → 델타 측정' },
] as const;

function formatMemoryTotal(bytes?: number): string {
  if (!bytes) return '수집 중';
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

function formatTransferRate(bytesPerSecond?: number | null): string {
  if (bytesPerSecond == null) return '수집 중';
  const mb = bytesPerSecond / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  const kb = bytesPerSecond / 1024;
  if (kb >= 1) return `${Math.round(kb)} KB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

function summarizeEvent(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 72)}...` : oneLine;
}

function WorkflowStep({
  num,
  label,
  sublabel,
  status,
  active,
  isLast,
  onClick,
}: {
  num: number;
  label: string;
  sublabel: string;
  status: StepStatus;
  active: boolean;
  isLast: boolean;
  onClick?: () => void;
}) {
  const badgeClass = `nd-step-badge nd-step-badge-${status}${active ? ' nd-step-badge-current' : ''}`;
  const itemClass = `nd-workflow-step${active ? ' active' : ''}${status === 'locked' ? ' locked' : ''}`;

  return (
    <div className="nd-workflow-step-wrap">
      <button
        type="button"
        className={itemClass}
        onClick={status !== 'locked' ? onClick : undefined}
        disabled={status === 'locked'}
        aria-label={label}
        aria-current={active ? 'step' : undefined}
      >
        <span className={badgeClass} aria-hidden="true">
          {status === 'done' && '✓'}
          {status === 'failed' && '✕'}
          {(status === 'idle' || status === 'active' || status === 'locked') && num}
        </span>
        <span className="nd-step-info">
          <span className="nd-step-label">{label}</span>
          <span className="nd-step-sublabel">{sublabel}</span>
        </span>
      </button>
      {!isLast && (
        <div
          className={`nd-step-connector${status === 'done' ? ' done' : status === 'active' ? ' partial' : ''}`}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

function HypoCard({
  hypo,
  status,
  onStatus,
}: {
  hypo: Hypothesis;
  status: HypoStatus;
  onStatus: (id: string, next: HypoStatus) => void;
}) {
  const confidencePct = Math.round(hypo.confidence * 100);
  const tone = confidencePct >= 70
    ? 'var(--color-success)'
    : confidencePct >= 50
      ? 'var(--color-warning)'
      : 'var(--color-text-hint)';

  return (
    <article className={`nd-hypothesis-card is-${status}`}>
      <div className="nd-hypothesis-meta">
        <span className={`nd-hypothesis-priority priority-${hypo.priority.toLowerCase()}`}>{hypo.priority}</span>
        <span className="nd-hypothesis-confidence-pill">확신도 {confidencePct}%</span>
      </div>
      <div className="nd-hypothesis-head">
        <h4 className="nd-hypothesis-title">{hypo.title}</h4>
      </div>
      <p className="nd-hypothesis-kicker">지금 해볼 조치</p>
      <p className="nd-hypothesis-desc">{hypo.description}</p>
      <div className="nd-hypothesis-confidence">
        <div className="nd-progress">
          <div className="nd-progress-fill" style={{ width: `${confidencePct}%`, background: tone }} />
        </div>
        <span className="nd-hypothesis-percent">우선 확인</span>
      </div>
      {hypo.confidence < 0.6 && (
        <div className="nd-confidence-warn-banner" role="alert">
          <span className="nd-confidence-warn-icon" aria-hidden="true">⚠</span>
          <span>확신도 {confidencePct}% — 수리기사 상담을 권장합니다.</span>
        </div>
      )}
      <div className="nd-hypothesis-actions">
        {status === 'idle' && (
          <button type="button" className="nd-chip-button" onClick={() => onStatus(hypo.id, 'trying')}>
            이 조치 시도하기
          </button>
        )}
        {status === 'trying' && (
          <>
            <button type="button" className="nd-chip-button accent" onClick={() => onStatus(hypo.id, 'checking')}>
              해봤어요
            </button>
            <button type="button" className="nd-chip-button muted" onClick={() => onStatus(hypo.id, 'failed')}>
              효과 없어요
            </button>
          </>
        )}
        {status === 'checking' && (
          <div className="nd-hypo-check-branch">
            <p className="nd-hypo-check-prompt">시도 후 증상이 사라졌나요?</p>
            <div className="nd-hypo-check-actions">
              <button type="button" className="nd-chip-button accent" onClick={() => onStatus(hypo.id, 'done')}>
                해결됐어요
              </button>
              <button type="button" className="nd-chip-button muted" onClick={() => onStatus(hypo.id, 'failed')}>
                아직 안 됐어요
              </button>
            </div>
          </div>
        )}
        {status === 'done' && <span className="nd-status-pill success">완료</span>}
        {status === 'failed' && <span className="nd-status-pill error">추가 점검 필요</span>}
      </div>
    </article>
  );
}

interface Props {
  sysInfo: SystemSnapshot | null;
  cpuHistory: number[];
  symptom: string;
  clipboardImage: ClipboardImage | null;
  isLoading: boolean;
  apiError: string | null;
  processData: ProcessData | null;
  eventLogs: EventLog[];
  diagnosisResponse: HypothesesResponse | null;
  onSymptomChange: (value: string) => void;
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>;
  onDiagnose: () => void;
  onClearImage: () => void;
  onReset: () => void;
}

export default function ElectronDashboard({
  sysInfo,
  cpuHistory: _cpuHistory,
  symptom,
  clipboardImage,
  isLoading,
  apiError,
  processData,
  eventLogs,
  diagnosisResponse,
  onSymptomChange,
  onPaste,
  onDiagnose,
  onClearImage,
  onReset,
}: Props) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('diagnose');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [hypoStatuses, setHypoStatuses] = useState<Record<string, HypoStatus>>({});
  const [showConversationLayout, setShowConversationLayout] = useState(false);
  const [isConversationMorphing, setIsConversationMorphing] = useState(false);
  const [isZooming, setIsZooming] = useState(false);
  const [reproState, setReproState] = useState<ReproState>('idle');
  const [baselineSnapshot, setBaselineSnapshot] = useState<{ cpu: number | null; mem: number | null } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const errorCount = eventLogs.filter(log => log.levelDisplayName === 'Error' || log.levelDisplayName === 'Critical').length;
  const warningCount = eventLogs.filter(log => log.levelDisplayName === 'Warning').length;
  const memoryUsagePct = sysInfo ? Math.round((sysInfo.memory.used / sysInfo.memory.total) * 100) : null;
  const cpuTemp = sysInfo?.cpu.temperature != null ? `${Math.round(sysInfo.cpu.temperature)}°C` : '측정 중';
  const topProcess = processData?.byCpu[0]?.name ?? '대기 중';
  const gpuLabel = sysInfo?.gpu?.model ?? '그래픽 정보 대기';
  const recentActivities = eventLogs.slice(0, 3);
  const cpuUsage = sysInfo ? Math.round(sysInfo.cpu.usage) : null;
  const diskTraffic = sysInfo?.disk ? sysInfo.disk.read + sysInfo.disk.write : null;
  const quickSymptomChips = [
    '부팅이 평소보다 많이 느려졌어요.',
    '특정 프로그램만 실행하면 화면이 멈춥니다.',
    '팬 소음과 발열이 갑자기 심해졌어요.',
    '게임이나 영상 편집 중 프레임 드랍이 심합니다.',
  ];

  const heroSummary = !sysInfo
    ? '실시간 텔레메트리를 수집하는 중입니다. 지금 느끼는 증상을 먼저 적어두면 수집 완료 후 바로 원인 후보를 좁혀드립니다.'
    : errorCount > 0
      ? `최근 오류 ${errorCount}건과 경고 ${warningCount}건이 감지되었습니다. ${topProcess} 관련 부하 여부와 함께 증상을 입력해보세요.`
      : memoryUsagePct != null && memoryUsagePct >= 80
        ? `메모리 점유율이 ${memoryUsagePct}%로 높습니다. 백그라운드 앱 누적 점유나 특정 프로세스 병목 가능성을 먼저 확인해보는 것이 좋습니다.`
        : cpuUsage != null && cpuUsage >= 75
          ? `CPU 사용률이 ${cpuUsage}%로 높게 유지되고 있습니다. ${topProcess} 같은 상위 프로세스의 순간 부하와 이벤트 로그를 함께 보는 것이 좋습니다.`
          : '현재 시스템은 비교적 안정적으로 보입니다. 증상이 발생하는 순간의 상황을 적어주시면 AI가 원인 후보를 더 정확하게 정리해드립니다.';

  useEffect(() => {
    if (diagnosisResponse) {
      setMessages(prev => [...prev.filter(m => m.kind !== 'error'), { kind: 'ai-hypo', response: diagnosisResponse }]);
      const nextStatuses: Record<string, HypoStatus> = {};
      diagnosisResponse.hypotheses.forEach(hypo => { nextStatuses[hypo.id] = 'idle'; });
      setHypoStatuses(nextStatuses);
    }
  }, [diagnosisResponse]);

  useEffect(() => {
    if (apiError) {
      setMessages(prev => [...prev.filter(m => m.kind !== 'error'), { kind: 'error', text: apiError }]);
      // If error arrives before conversation layout (e.g., zoom already started), ensure it shows
      if (!showConversationLayout) {
        setShowConversationLayout(true);
        setIsConversationMorphing(true);
        window.setTimeout(() => setIsConversationMorphing(false), 520);
      }
    }
  }, [apiError]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const anchor = messagesEndRef.current;
    if (anchor && typeof anchor.scrollIntoView === 'function') {
      anchor.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  const heroLead = !sysInfo
    ? '시스템 데이터를 모으는 동안, 현재 겪는 문제를 한 줄로 적어주시면 바로 분석을 시작할 수 있어요.'
    : errorCount > 0
      ? `오류 ${errorCount}건, 경고 ${warningCount}건이 감지되었습니다. 증상 설명과 함께 보내주시면 더 정확하게 원인을 좁힐 수 있어요.`
      : '';

  const systemRisk = errorCount > 0
    ? 'attention'
    : memoryUsagePct != null && memoryUsagePct >= 80
      ? 'warning'
      : cpuUsage != null && cpuUsage >= 75
        ? 'warning'
        : 'stable';
  const systemRiskLabel = systemRisk === 'attention'
    ? '주의 필요'
    : systemRisk === 'warning'
      ? '부하 관찰'
      : '정상 범위';
  const readinessScore = sysInfo
    ? Math.max(42, Math.min(96, 96 - errorCount * 14 - warningCount * 4 - (memoryUsagePct != null && memoryUsagePct >= 80 ? 10 : 0)))
    : 28;

  const handleSend = () => {
    if (!symptom.trim() || isLoading || isZooming) return;
    const text = symptom.trim();
    setMessages(prev => [...prev, { kind: 'user', text }]);
    setIsZooming(true);

    window.setTimeout(() => {
      setIsZooming(false);
      setShowConversationLayout(true);
      setIsConversationMorphing(true);
      onDiagnose();
      window.setTimeout(() => setIsConversationMorphing(false), 520);
    }, 380);
  };

  const handleReset = () => {
    setMessages([]);
    setHypoStatuses({});
    setIsZooming(false);
    setShowConversationLayout(false);
    setIsConversationMorphing(false);
    setReproState('idle');
    setBaselineSnapshot(null);
    onReset();
  };

  const allExhausted = diagnosisResponse
    ? Object.values(hypoStatuses).length > 0 && Object.values(hypoStatuses).every(s => s === 'done' || s === 'failed')
    : false;
  const isResolved = Object.values(hypoStatuses).some(s => s === 'done');
  const hasStartedDiagnosis = messages.some(m => m.kind === 'user');
  const activeStepNumber = !hasStartedDiagnosis ? 1 : allExhausted ? 3 : 2;

  const getStepStatus = (stepNum: number): StepStatus => {
    switch (stepNum) {
      case 1: return hasStartedDiagnosis ? 'done' : 'active';
      case 2:
        if (!hasStartedDiagnosis) return 'locked';
        return allExhausted ? 'done' : 'active';
      case 3: return allExhausted ? 'active' : 'locked';
      default: return 'locked';
    }
  };

  const handleStepClick = (stepNum: number) => {
    setActiveTab('diagnose');
    if (stepNum === 3 && allExhausted && reproState === 'idle') {
      setReproState('baseline');
    }
  };

  const renderPromptShell = (conversationMode = false) => (
    <div className={`nd-prompt-shell${conversationMode ? ' is-conversation' : ''}`}>
      <div className="nd-prompt-toolbar">
        <span className="nd-prompt-toolbar-left">
          {conversationMode ? '추가 증상이나 상황을 보충해 주세요.' : '증상을 한 줄로 적으면 바로 원인 후보를 정리해드립니다.'}
        </span>
        <span className="nd-prompt-toolbar-right">Enter 전송</span>
      </div>

      <textarea
        className="nd-prompt-input"
        placeholder="예: 영상 편집 프로그램 실행 시 화면이 깜빡이고 본체 팬 소음이 급격히 커집니다. 때때로 VIDEO_TDR_FAILURE 블루스크린이 발생합니다."
        value={symptom}
        rows={conversationMode ? 3 : 5}
        onChange={event => onSymptomChange(event.target.value)}
        onPaste={onPaste}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSend();
          }
        }}
      />

      <div className="nd-prompt-footer">
        <div className="nd-prompt-footer-left">
          <span className="nd-trust-pill">{sysInfo ? '실시간 시스템 데이터 반영' : '시스템 데이터 수집 중'}</span>
          <span className="nd-trust-copy">스크린샷은 붙여넣기로 바로 첨부할 수 있습니다.</span>
        </div>

        <div className="nd-prompt-footer-right">
          {clipboardImage && (
            <div className="nd-attachment-pill">
              <img src={clipboardImage.dataUrl} alt="첨부 이미지" />
              <span>스크린샷 첨부됨</span>
              <button type="button" onClick={onClearImage} aria-label="이미지 제거">✕</button>
            </div>
          )}
          <button
            type="button"
            className="nd-submit-fab"
            onClick={handleSend}
            disabled={!symptom.trim() || isLoading || isZooming}
          >
            {isLoading ? '분석 중...' : 'AI 진단 시작하기'}
          </button>
        </div>
      </div>
    </div>
  );

  const renderRecentActivity = () => (
    <section className="nd-diagnose-activity card-glass">
      <div className="nd-section-heading">
        <div>
          <p className="nd-panel-label">최근 활동</p>
          <h2 className="nd-section-title">최근 감지된 시스템 흔적</h2>
        </div>
        <button type="button" className="nd-text-link" disabled aria-disabled="true">
          전체 기록 보기
        </button>
      </div>

      <div className="nd-activity-list">
        {recentActivities.length > 0 ? recentActivities.map((event, index) => (
          <article key={`${event.id}-${index}`} className="nd-activity-card">
            <div className={`nd-activity-icon ${event.levelDisplayName === 'Warning' ? 'warning' : event.levelDisplayName === 'Error' || event.levelDisplayName === 'Critical' ? 'danger' : 'neutral'}`}>
              {event.levelDisplayName === 'Warning' ? '!' : event.levelDisplayName === 'Error' || event.levelDisplayName === 'Critical' ? 'x' : 'i'}
            </div>
            <div className="nd-activity-copy">
              <strong>{event.providerName || `이벤트 ${event.id}`}</strong>
              <p>{summarizeEvent(event.message || `${event.levelDisplayName} 로그가 수집되었습니다.`)}</p>
            </div>
            <span className="nd-activity-chevron" aria-hidden="true">›</span>
          </article>
        )) : (
          <div className="nd-activity-empty">최근 시스템 이벤트가 아직 수집되지 않았습니다.</div>
        )}
      </div>
    </section>
  );

  const renderSystemAside = () => (
    <div className="nd-diagnose-side-stack">
      <section className="nd-system-preview card-glass">
        <div className="nd-system-preview-head">
          <span className="nd-chip-badge accent">{sysInfo ? '실시간 측정 중' : '연결 대기'}</span>
          <span className={`nd-status-pill ${errorCount > 0 ? 'error' : 'success'}`}>
            {errorCount > 0 ? `오류 ${errorCount}건 감지` : '안정 상태'}
          </span>
        </div>

        <div className="nd-system-preview-copy">
          <p className="nd-panel-label">실시간 시스템 스냅샷</p>
          <h3>지금 확인된 상태를 바탕으로 바로 진단을 시작할 수 있어요.</h3>
          <p className="nd-system-preview-summary">{heroSummary}</p>
        </div>

        <div className="nd-system-health-grid" aria-label="핵심 시스템 상태">
          <article className="nd-system-health-card">
            <span><Cpu size={13} /> CPU 사용률</span>
            <strong>{cpuUsage != null ? `${cpuUsage}%` : '수집 중'}</strong>
          </article>
          <article className="nd-system-health-card">
            <span><Activity size={13} /> 메모리 점유</span>
            <strong>{memoryUsagePct != null ? `${memoryUsagePct}%` : '수집 중'}</strong>
          </article>
          <article className="nd-system-health-card">
            <span><ShieldCheck size={13} /> 디스크 I/O</span>
            <strong>{formatTransferRate(diskTraffic)}</strong>
          </article>
          <article className="nd-system-health-card">
            <span><AlertTriangle size={13} /> 최근 오류</span>
            <strong>{errorCount}건</strong>
          </article>
        </div>

        <div className="nd-system-preview-meta">
          <span><i className="status-online" /> 라이브 연결</span>
          <span>CPU 온도 {cpuTemp}</span>
          <span>상위 프로세스 {topProcess}</span>
        </div>

        <div className="nd-quick-symptom-row" aria-label="빠른 증상 선택">
          {quickSymptomChips.map(chip => (
            <button
              key={chip}
              type="button"
              className="nd-quick-symptom-chip"
              onClick={() => onSymptomChange(chip)}
            >
              {chip}
            </button>
          ))}
        </div>
      </section>

      <section className="nd-system-specs card-glass">
        <div className="nd-section-heading compact">
          <div>
            <p className="nd-panel-label">하드웨어 사양</p>
            <h3 className="nd-side-card-title">실시간 시스템 정보</h3>
          </div>
        </div>
        <div className="nd-spec-list">
          <div className="nd-spec-row">
            <span>CPU 사용률</span>
            <strong>{sysInfo ? `${Math.round(sysInfo.cpu.usage)}%` : '수집 중'}</strong>
          </div>
          <div className="nd-spec-row">
            <span>메모리 사용량</span>
            <strong>{memoryUsagePct != null ? `${memoryUsagePct}% / ${formatMemoryTotal(sysInfo?.memory.total)}` : '수집 중'}</strong>
          </div>
          <div className="nd-spec-row">
            <span>그래픽</span>
            <strong>{gpuLabel}</strong>
          </div>
          <div className="nd-spec-row">
            <span>상위 프로세스</span>
            <strong>{topProcess}</strong>
          </div>
        </div>
      </section>

      <section className="nd-system-tip card-glass soft">
        <div className="nd-tip-icon" aria-hidden="true">i</div>
        <div>
          <p className="nd-side-card-title">전문가 팁</p>
          <p className="nd-system-tip-copy">
            문제가 발생하는 시점과 함께 스크린샷을 붙여넣으면 드라이버 충돌이나 특정 앱 병목을 더 빠르게 구분할 수 있습니다.
          </p>
        </div>
      </section>
    </div>
  );

  const renderDiagnosis = () => (
    <div className={`nd-diagnose-stage${isZooming ? ' is-zooming-entry' : ''}`}>
      {/* Zoom overlay — expands from input card position, covers screen, then conversation replaces */}
      {isZooming && <div className="nd-zoom-overlay" aria-hidden="true" />}

      {/* Landing view — shown before any diagnosis */}
      {!showConversationLayout && (
        <section className="nd-landing-view nd-diagnose-page">
          <div className="nd-diagnose-main">
            <section className="nd-page-intro animate-fade-in-up">
              <div className="nd-archive-ticker" aria-hidden="true">
                <span>실시간 상태 확인</span>
                <span>이벤트 로그 반영</span>
                <span>AI 원인 후보 정리</span>
              </div>
              <p className="nd-page-kicker">AI PC 진단</p>
              <h1 className="nd-page-headline">지금 PC 증상을 알려주세요</h1>
              <p className="nd-page-description">
                현재 PC에서 겪는 증상을 입력하면 실시간 텔레메트리, 이벤트 로그, 프로세스 부하를 한 번에 묶어 원인 후보를 추적합니다.
              </p>
              {heroLead ? <p className="nd-page-helper">{heroLead}</p> : null}
              <div className="nd-product-health-strip" aria-label="진단 준비 상태">
                <article className={`nd-product-health-card ${systemRisk}`}>
                  <span>현재 위험도</span>
                  <strong>{systemRiskLabel}</strong>
                </article>
                <article className="nd-product-health-card">
                  <span>진단 준비도</span>
                  <strong>{readinessScore}%</strong>
                </article>
                <article className="nd-product-health-card">
                  <span>수집 근거</span>
                  <strong>{eventLogs.length} logs</strong>
                </article>
              </div>
              <div className="nd-command-visual" aria-label="진단 대상 하드웨어 맵">
                <div className="nd-command-visual-media">
                  <img src="/pc-diagram.png" alt="PC 내부 하드웨어 진단 맵" />
                  <span className="nd-archive-crosshair" aria-hidden="true" />
                  <span className="nd-command-hotspot cpu">CPU</span>
                  <span className="nd-command-hotspot gpu">GPU</span>
                  <span className="nd-command-hotspot ram">RAM</span>
                  <span className="nd-command-scanline" aria-hidden="true" />
                </div>
                <div className="nd-command-visual-readout">
                  <span>진단 상태</span>
                  <strong>{sysInfo ? '연결됨' : '대기 중'}</strong>
                  <p>증상, 이벤트 로그, 프로세스 부하, 하드웨어 위치를 하나의 진단 리포트로 정리합니다.</p>
                </div>
              </div>
            </section>

            <section className="nd-diagnose-entry card-glass animate-spring-in">
              {renderPromptShell(false)}
            </section>

            {renderRecentActivity()}
          </div>

          <aside className="nd-diagnose-side animate-fade-in-up delay-150">
            {renderSystemAside()}
          </aside>
        </section>
      )}

      {/* Full-screen chat view — zooms in after submission */}
      {showConversationLayout && (
        <div className={`nd-chat-fullview${isConversationMorphing ? ' is-entering' : ''}`}>

          {/* Compact system status strip */}
          <div className="nd-chat-status-strip">
            <i className="status-online nd-chat-status-dot" aria-hidden="true" />
            <span className="nd-panel-label" style={{ margin: 0 }}>실시간 연결</span>
            <div className="nd-chat-status-metrics">
              <span>CPU {cpuUsage != null ? `${cpuUsage}%` : '—'}</span>
              <span>메모리 {memoryUsagePct != null ? `${memoryUsagePct}%` : '—'}</span>
              {errorCount > 0 && <span className="nd-chat-status-error">오류 {errorCount}건</span>}
            </div>
            <button type="button" className="nd-chip-button" style={{ marginLeft: 'auto' }} onClick={handleReset}>
              새 진단
            </button>
          </div>

          {/* Scrollable chat feed */}
          <div className="nd-chat-feed">
            {messages.map((message, index) => {
              if (message.kind === 'user') {
                return (
                  <div key={`user-${index}`} className="nd-message user">
                    <div className="nd-bubble user">{message.text}</div>
                  </div>
                );
              }

              if (message.kind === 'error') {
                return (
                  <div key={`error-${index}`} className="nd-message">
                    <div className="nd-bubble error">{message.text}</div>
                  </div>
                );
              }

              return (
                <div key={`ai-${index}`} className="nd-message">
                  <div className="nd-bubble ai">
                    <p className="nd-bubble-intro">
                      {message.response.immediateAction || `${message.response.hypotheses.length}가지 가능성을 찾았습니다. 가능성 높은 조치부터 순서대로 확인해 보세요.`}
                    </p>
                    <div className="nd-hypothesis-row">
                      {message.response.hypotheses.map(hypo => (
                        <HypoCard
                          key={hypo.id}
                          hypo={hypo}
                          status={hypoStatuses[hypo.id] ?? 'idle'}
                          onStatus={(id, next) => setHypoStatuses(prev => ({ ...prev, [id]: next }))}
                        />
                      ))}
                    </div>
                    {/* 해결됨 완료 카드 */}
                    {isResolved && (
                      <div className="nd-resolved-card">
                        <span className="nd-resolved-icon" aria-hidden="true">✓</span>
                        <div>
                          <strong>문제가 해결됐군요!</strong>
                          <p>도움이 됐다니 기쁩니다. 같은 증상이 다시 생기면 언제든지 돌아오세요.</p>
                        </div>
                      </div>
                    )}

                    {/* 모든 가설 소진 — 미해결 시 재현 모드 */}
                    {allExhausted && !isResolved && reproState === 'idle' && (
                      <div className="nd-exhausted-card">
                        <strong>모든 가설을 시도했어요.</strong>
                        <p>증상을 직접 재현해서 시스템 변화를 측정해볼게요. 재현 모드로 넘어갑니다.</p>
                        <button
                          type="button"
                          className="nd-chip-button accent"
                          style={{ marginTop: 10 }}
                          onClick={() => setReproState('baseline')}
                        >
                          재현 모드 시작하기 →
                        </button>
                      </div>
                    )}

                    {/* 재현 모드 패널 */}
                    {allExhausted && !isResolved && reproState !== 'idle' && (() => {
                      const cpuDelta = baselineSnapshot?.cpu != null && cpuUsage != null
                        ? cpuUsage - baselineSnapshot.cpu : null;
                      const memDelta = baselineSnapshot?.mem != null && memoryUsagePct != null
                        ? memoryUsagePct - baselineSnapshot.mem : null;
                      const isSignificant = (cpuDelta != null && cpuDelta >= 15) || (memDelta != null && memDelta >= 10);

                      return (
                        <div className="nd-repro-panel">
                          {reproState === 'baseline' && (
                            <>
                              <div className="nd-repro-step-badge">1단계 — 베이스라인 측정</div>
                              <p className="nd-repro-desc">
                                지금 PC가 평상시 상태인지 확인합니다. 아무것도 실행하지 말고 잠시 기다려 주세요.
                              </p>
                              {((cpuUsage != null && cpuUsage >= 90) || (memoryUsagePct != null && memoryUsagePct >= 95)) && (
                                <div className="nd-baseline-warn" role="alert">
                                  <span className="nd-baseline-warn-icon" aria-hidden="true">⚠</span>
                                  <div>
                                    <strong>현재 시스템 부하가 매우 높습니다.</strong>
                                    <p>
                                      {cpuUsage != null && cpuUsage >= 90 && `CPU ${cpuUsage}%`}
                                      {cpuUsage != null && cpuUsage >= 90 && memoryUsagePct != null && memoryUsagePct >= 95 && ' · '}
                                      {memoryUsagePct != null && memoryUsagePct >= 95 && `메모리 ${memoryUsagePct}%`}
                                      {' '}— 이미 비정상 상태일 수 있어요. 잠시 기다린 후 부하가 내려가면 저장하세요.
                                    </p>
                                  </div>
                                </div>
                              )}
                              <div className="nd-repro-metrics">
                                <div className="nd-repro-metric">
                                  <span>CPU</span>
                                  <strong>{cpuUsage != null ? `${cpuUsage}%` : '—'}</strong>
                                </div>
                                <div className="nd-repro-metric">
                                  <span>메모리</span>
                                  <strong>{memoryUsagePct != null ? `${memoryUsagePct}%` : '—'}</strong>
                                </div>
                              </div>
                              <button
                                type="button"
                                className="nd-chip-button accent"
                                onClick={() => {
                                  setBaselineSnapshot({ cpu: cpuUsage, mem: memoryUsagePct });
                                  setReproState('reproducing');
                                }}
                              >
                                베이스라인 저장 후 재현 시작 →
                              </button>
                            </>
                          )}
                          {reproState === 'reproducing' && (
                            <>
                              <div className="nd-repro-step-badge active">2단계 — 증상 재현 중</div>
                              <p className="nd-repro-desc">
                                이제 문제가 생기는 상황을 만들어 주세요. 게임 실행, 영상 편집 등 증상이 나타나는 동작을 해보세요.
                              </p>
                              <div className="nd-repro-metrics">
                                <div className="nd-repro-metric">
                                  <span>CPU (현재)</span>
                                  <strong>{cpuUsage != null ? `${cpuUsage}%` : '—'}</strong>
                                </div>
                                <div className="nd-repro-metric">
                                  <span>메모리 (현재)</span>
                                  <strong>{memoryUsagePct != null ? `${memoryUsagePct}%` : '—'}</strong>
                                </div>
                              </div>
                              <button
                                type="button"
                                className="nd-chip-button accent"
                                onClick={() => setReproState('done')}
                              >
                                재현 완료 — 결과 분석하기 →
                              </button>
                            </>
                          )}
                          {reproState === 'done' && (
                            <>
                              <div className="nd-repro-step-badge done">측정 완료</div>
                              {baselineSnapshot && (
                                <div className="nd-repro-delta-grid">
                                  <div className="nd-repro-delta-item">
                                    <span>CPU 변화</span>
                                    <strong className={cpuDelta != null && cpuDelta >= 15 ? 'nd-delta-high' : ''}>
                                      {cpuDelta != null ? `${cpuDelta >= 0 ? '+' : ''}${cpuDelta}%p` : '—'}
                                    </strong>
                                  </div>
                                  <div className="nd-repro-delta-item">
                                    <span>메모리 변화</span>
                                    <strong className={memDelta != null && memDelta >= 10 ? 'nd-delta-high' : ''}>
                                      {memDelta != null ? `${memDelta >= 0 ? '+' : ''}${memDelta}%p` : '—'}
                                    </strong>
                                  </div>
                                </div>
                              )}
                              {isSignificant ? (
                                <div className="nd-repro-result significant">
                                  <strong>소프트웨어 원인이 확인됐습니다.</strong>
                                  <p>재현 시 시스템 부하가 유의미하게 상승했습니다. 가설 목록의 조치를 다시 점검하거나 추가 진단을 요청해보세요.</p>
                                </div>
                              ) : (
                                <div className="nd-repro-result intermittent">
                                  <strong>증상을 재현하기 어려운 상태예요.</strong>
                                  <p>간헐적 증상이라 지금 당장 파악이 어려워요. 증상이 다시 나타날 때 재시도하거나, 수리기사 상담을 권장합니다.</p>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })()}

                    {/* 복합 원인 — 소진 후 미해결 시만 노출 */}
                    {allExhausted && !isResolved && (
                      <div className="nd-compound-cause-bar">
                        <span className="nd-compound-cause-hint">복합 원인이 있을 수 있어요.</span>
                        <button
                          type="button"
                          className="nd-chip-button muted"
                          onClick={() => {
                            setReproState('idle');
                            setBaselineSnapshot(null);
                            setHypoStatuses({});
                            onDiagnose();
                          }}
                        >
                          이게 전부가 아닐 수 있어요 →
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {isLoading && (
              <div className="nd-message">
                <div className="nd-bubble ai">
                  <p className="nd-bubble-loading">시스템 스냅샷과 증상을 종합해서 가설을 정리하는 중입니다.</p>
                  <div className="nd-loading-dots" aria-label="분석 중">
                    <span /><span /><span />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Sticky input dock */}
          <div className="nd-chat-input-dock">
            {renderPromptShell(true)}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="nd-chat-shell nd-redesign-shell">
      <aside className="nd-rail nd-rail-workflow nd-redesign-sidebar">
        <div className="nd-rail-header nd-redesign-brand">
          <div className="nd-redesign-brand-mark" aria-hidden="true">
            <Sparkles size={18} />
          </div>
          <div>
            <strong className="nd-redesign-brand-title">옆집 컴공생</strong>
            <p className="nd-redesign-brand-subtitle">AI PC diagnosis</p>
          </div>
        </div>

        <nav className="nd-redesign-nav" aria-label="주요 메뉴">
          <button type="button" className={`nd-redesign-nav-item${activeTab === 'diagnose' ? ' active' : ''}`} onClick={() => setActiveTab('diagnose')}>
            <span className="nd-redesign-nav-icon" aria-hidden="true"><Activity size={17} /></span>
            <span>증상 입력</span>
          </button>
          <button type="button" className="nd-redesign-nav-item" disabled aria-disabled="true">
            <span className="nd-redesign-nav-icon" aria-hidden="true"><History size={17} /></span>
            <span>진단 기록</span>
          </button>
          <button type="button" className="nd-redesign-nav-item" onClick={() => setActiveTab('diagnose')}>
            <span className="nd-redesign-nav-icon" aria-hidden="true"><Link2 size={17} /></span>
            <span>세션 연결</span>
          </button>
          <button type="button" className="nd-redesign-nav-item" onClick={() => setActiveTab('diagnose')}>
            <span className="nd-redesign-nav-icon" aria-hidden="true"><BookOpen size={17} /></span>
            <span>사용 가이드</span>
          </button>
        </nav>

        <div className="nd-rail-section">
          <p className="nd-rail-section-label">진단 단계</p>
          <div className="nd-rail-progress-summary">
            <span className="nd-rail-progress-step">현재 {activeStepNumber}/3 단계</span>
            <span className="nd-rail-progress-copy">
              {activeStepNumber === 1
                ? '증상을 입력하면 바로 가설 단계로 넘어갑니다.'
                : activeStepNumber === 2
                  ? '가능성 높은 조치부터 하나씩 확인해보세요.'
                  : '모든 가설을 확인했어요. 재현 모드를 시작하세요.'}
            </span>
          </div>
          <div className="nd-workflow-steps">
            {WORKFLOW_STEPS.map((step, i) => {
              const status = getStepStatus(step.num);
              const isActiveStep = step.num === activeStepNumber;

              return (
                <WorkflowStep
                  key={step.num}
                  num={step.num}
                  label={step.label}
                  sublabel={step.sublabel}
                  status={status}
                  active={isActiveStep}
                  isLast={i === WORKFLOW_STEPS.length - 1}
                  onClick={() => handleStepClick(step.num)}
                />
              );
            })}
          </div>
        </div>

        <div className="nd-redesign-sidebar-actions">
          <button type="button" className="nd-redesign-scan-button">
            전체 스캔 시작
          </button>
        </div>

        <div className="nd-rail-footer">
          <button type="button" className="nd-rail-util-button" aria-label="설정">
            <span aria-hidden="true"><Settings size={15} /></span>
            <span>설정</span>
          </button>
          <button type="button" className="nd-rail-util-button" aria-label="고객 센터">
            <span aria-hidden="true">?</span>
            <span>고객 센터</span>
          </button>
          <button type="button" className="nd-rail-util-button" aria-label="로그아웃">
            <span aria-hidden="true">↗</span>
            <span>로그아웃</span>
          </button>
        </div>
      </aside>

      <div className="nd-chat-stage nd-redesign-stage">
        <header className="nd-chat-topbar nd-redesign-topbar">
          <div className="nd-redesign-search">
            <span className="nd-redesign-search-icon" aria-hidden="true"><Search size={16} /></span>
            <input type="text" placeholder="진단 기록 및 증상 검색..." aria-label="진단 기록 및 증상 검색" />
          </div>
          <div className="nd-topbar-health-summary" aria-label="현재 시스템 상태">
            <span className={`nd-topbar-risk-dot ${systemRisk}`} />
            <strong>{systemRiskLabel}</strong>
            <span>CPU {cpuUsage != null ? `${cpuUsage}%` : '—'}</span>
            <span>MEM {memoryUsagePct != null ? `${memoryUsagePct}%` : '—'}</span>
          </div>
          <div className="nd-chat-actions">
            <button type="button" className="nd-toolbar-button">알림</button>
            <button type="button" className="nd-toolbar-button primary" onClick={handleReset}>새 진단</button>
          </div>
        </header>

        <main className="nd-chat-content nd-redesign-content">
          {activeTab === 'diagnose' && renderDiagnosis()}

          {activeTab === 'process' && (
            <section className="nd-section-page">
              <div className="nd-page-hero">
                <p className="nd-panel-label">시스템 점검</p>
                <h1 className="nd-page-title">CPU와 메모리를 많이 쓰는 프로세스를 한 번에 살펴보세요.</h1>
                <p className="nd-page-copy">
                  성능 저하의 직접 원인이 되는 상위 프로세스를 정렬 기준별로 확인하고, 병목이 특정 앱인지 전체 시스템인지 빠르게 구분할 수 있습니다.
                </p>
              </div>
              <ProcessList />
            </section>
          )}

          {activeTab === 'events' && null}
        </main>
      </div>
    </div>
  );
}
