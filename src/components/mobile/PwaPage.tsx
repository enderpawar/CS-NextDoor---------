/**
 * PwaPage — Claude Design 포팅 (옆집 컴공생.html)
 *
 * 화면 흐름: onboarding(01) → home(02) → context(03) → live-guide(05)
 *
 * iOS Safari: 카메라 권한 유지를 위해 페이지 이동 금지.
 * 기능 전환은 state 기반 (페이지 이동 없음).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle, Camera, CheckCircle2, Cpu, FileImage, ImagePlus, Mic, Monitor, Power, Sparkles,
  ArrowLeft, ArrowRight, Trash2, Wrench,
} from 'lucide-react';
import type { GuideContext } from '../../types';
import '../../styles/mobile.css';
import LiveGuideMode  from './LiveGuideMode';

// ── 디자인 시스템 — Ocean 팔레트 ─────────────────────────────────────────────
const C = {
  brand:      'oklch(0.56 0.15 245)',
  brandDeep:  'oklch(0.42 0.16 248)',
  brandSoft:  'oklch(0.96 0.028 245)',
  brandFaint: 'oklch(0.985 0.012 245)',
  accent:     'oklch(0.78 0.13 195)',
  bg:         'oklch(0.985 0.005 240)',
  surface:    '#ffffff',
  ink:        'oklch(0.20 0.02 245)',
  inkSoft:    'oklch(0.50 0.015 245)',
  inkFaint:   'oklch(0.72 0.012 245)',
  line:       'oklch(0.93 0.008 245)',
  ok:         'oklch(0.66 0.14 155)',
} as const;

// ── 타입 ─────────────────────────────────────────────────────────────────────
type PwaView = 'onboarding' | 'home' | 'context' | 'gallery' | 'live-guide';
type GuideInputMode = 'camera' | 'gallery';

interface ProblemOption {
  id: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
  context: GuideContext;
  question: string;
}

interface PwaHistoryState {
  ndPwaView?: PwaView;
  ndPwaIndex?: number;
}

interface Props {
  isStandalone: boolean;
}

function normalizePwaView(view?: PwaView): PwaView {
  return view && view !== 'onboarding' ? view : 'home';
}

function inferGuideContextFromText(text: string): GuideContext {
  const normalized = text.toLowerCase();
  if (/(bios|uefi|boot|부트|부팅순서|부팅 순서|bootloader|boot loader|secure boot|usb|설치|포맷|재설치)/i.test(normalized)) {
    return 'BIOS_BOOT';
  }
  if (/(블루스크린|bsod|stop code|중지 코드|자동 재부팅)/i.test(normalized)) {
    return 'BLUE_SCREEN';
  }
  if (/(인터넷|wifi|wi-fi|와이파이|랜선|dns|공유기|네트워크)/i.test(normalized)) {
    return 'NETWORK_ISSUE';
  }
  if (/(느려|멈춤|버벅|발열|팬|소음|cpu|메모리|디스크)/i.test(normalized)) {
    return 'SLOW_PC';
  }
  if (/(실행|앱|프로그램|오류 창|설치 실패|무반응)/i.test(normalized)) {
    return 'APP_NOT_OPENING';
  }
  if (/(전원|안 켜|안켜|검은 화면|화면 안|로고에서|부팅 안)/i.test(normalized)) {
    return 'NO_BOOT';
  }
  return 'GENERAL';
}

// ── 공유 서브 컴포넌트 ────────────────────────────────────────────────────────

function AppLogo({ size = 56 }: { size?: number }) {
  return (
    <img
      src="/icons/icon-192.png?v=blue-app-icon-20260522"
      alt="옆집 컴공생"
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        objectFit: 'contain',
        display: 'block',
      }}
    />
  );
}

function AppWordmark({ size = 22, compact = false }: { size?: number; compact?: boolean }) {
  return (
    <span style={{ fontFamily: 'Pretendard, system-ui', fontWeight: 800, fontSize: size, letterSpacing: -0.6, color: C.ink, lineHeight: 1 }}>
      옆집<span style={{ color: C.brand }}>.</span>{!compact && ' 컴공생'}
    </span>
  );
}

function PillBtn({
  children, variant = 'primary', full = false,
  onClick, disabled = false, style: extraStyle = {},
}: {
  children: React.ReactNode; variant?: 'primary' | 'soft' | 'ghost' | 'outline';
  full?: boolean; onClick?: () => void; disabled?: boolean; style?: React.CSSProperties;
}) {
  const base: React.CSSProperties = {
    height: 56, borderRadius: 28, padding: '0 26px',
    fontFamily: 'Pretendard, system-ui', fontSize: 17, fontWeight: 700, letterSpacing: -0.3,
    border: 'none', cursor: disabled ? 'default' : 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    userSelect: 'none', whiteSpace: 'nowrap', width: full ? '100%' : undefined,
    opacity: disabled ? 0.5 : 1, ...extraStyle,
  };
  const vMap: Record<string, React.CSSProperties> = {
    primary: { background: C.brand, color: '#fff', boxShadow: `0 8px 20px -8px ${C.brand}88` },
    soft:    { background: C.brandSoft, color: C.brand },
    ghost:   { background: 'transparent', color: C.ink },
    outline: { background: C.surface, color: C.ink, boxShadow: `inset 0 0 0 1.5px ${C.line}` },
  };
  return <button type="button" style={{ ...base, ...vMap[variant] }} onClick={onClick} disabled={disabled}>{children}</button>;
}

function ProgressDot({ active = false }: { active?: boolean }) {
  return <div style={{ width: active ? 22 : 7, height: 7, borderRadius: 999, background: active ? C.brand : C.line, transition: 'width .2s' }}/>;
}

function FeatureRow({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px', borderRadius: 18, background: C.surface, boxShadow: `0 1px 0 ${C.line}, 0 8px 24px -16px ${C.brand}44` }}>
      <div style={{ width: 40, height: 40, borderRadius: 12, background: C.brandSoft, color: C.brand, display: 'grid', placeItems: 'center', flexShrink: 0 }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: C.ink, letterSpacing: -0.3 }}>{title}</div>
        <div style={{ fontSize: 12.5, color: C.inkSoft, marginTop: 2, letterSpacing: -0.2 }}>{sub}</div>
      </div>
    </div>
  );
}

function ReadinessItem({ icon, label, status }: { icon: React.ReactNode; label: string; status: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <div style={{ width: 34, height: 34, borderRadius: 10, background: C.brandSoft, color: C.brand, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 800, letterSpacing: -0.25, color: C.ink }}>{label}</div>
        <div style={{ marginTop: 2, fontSize: 12, fontWeight: 700, letterSpacing: -0.15, color: C.inkSoft }}>{status}</div>
      </div>
    </div>
  );
}

const PROBLEM_OPTIONS: ProblemOption[] = [
  {
    id: 'no-boot',
    icon: <Power size={20}/>,
    title: '부팅이 안 돼요',
    sub: '검은 화면, 로고 멈춤, 전원은 들어오는 상황',
    context: 'NO_BOOT',
    question: '부팅이 안 돼요. 전원 LED, 모니터 화면, 제조사 로고부터 확인해주세요.',
  },
  {
    id: 'error-screen',
    icon: <AlertCircle size={20}/>,
    title: '오류 화면이 떠요',
    sub: '블루스크린, 경고창, 멈춘 화면',
    context: 'BLUE_SCREEN',
    question: '오류 화면이 떠요. 화면의 문구와 코드를 보고 원인과 다음 조치를 알려주세요.',
  },
  {
    id: 'inside-pc',
    icon: <Cpu size={20}/>,
    title: '본체 내부를 확인하고 싶어요',
    sub: 'RAM, 그래픽카드, 케이블 상태 확인',
    context: 'HW_REPAIR_RAM',
    question: '본체 내부 상태를 확인하고 싶어요. RAM과 주요 부품을 안전하게 점검하도록 안내해주세요.',
  },
];

const DEFAULT_CAMERA_OPTION: ProblemOption = {
  id: 'default-camera',
  icon: <Camera size={20}/>,
  title: '화면부터 보기',
  sub: '화면 단서부터 보고 같이 분류',
  context: 'GENERAL',
  question: '',
};

const HERO_QUICK_OPTIONS: ProblemOption[] = [
  {
    id: 'quick-black-screen',
    icon: <Power size={16}/>,
    title: '검은 화면',
    sub: '전원·로고',
    context: 'NO_BOOT',
    question: '검은 화면 상태예요. 전원 LED, 모니터 신호, 제조사 로고 표시 여부부터 확인해주세요.',
  },
  {
    id: 'quick-blue-screen',
    icon: <AlertCircle size={16}/>,
    title: '블루스크린',
    sub: '오류 코드',
    context: 'BLUE_SCREEN',
    question: '블루스크린이 떠요. 화면의 중지 코드와 오류 문구를 읽고 다음 조치를 안내해주세요.',
  },
  {
    id: 'quick-bios',
    icon: <Monitor size={16}/>,
    title: 'BIOS 설정',
    sub: '부팅 순서',
    context: 'BIOS_BOOT',
    question: 'BIOS 또는 부팅 설정 화면이에요. 부팅 순서와 Secure Boot 관련 설정을 확인해주세요.',
  },
];

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export default function PwaPage({ isStandalone }: Props) {
  const [view,        setView]       = useState<PwaView>('home');
  const [selectedCtx, setSelectedCtx] = useState<GuideContext>('GENERAL');
  const [guideInputMode, setGuideInputMode] = useState<GuideInputMode>('camera');
  const [initialGalleryFiles, setInitialGalleryFiles] = useState<File[]>([]);
  const [galleryFiles, setGalleryFiles] = useState<File[]>([]);
  const [symptomText, setSymptomText] = useState('');
  const [initialGuideQuestion, setInitialGuideQuestion] = useState('');
  const homeGalleryInputRef = useRef<HTMLInputElement>(null);
  const historyIndexRef = useRef(0);
  const viewRef = useRef<PwaView>(view);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.classList.add('nd-pwa-viewport-lock');
    document.body.classList.add('nd-pwa-viewport-lock');

    const viewport = window.visualViewport;

    const isTextInputFocused = () => {
      const active = document.activeElement;
      return active instanceof HTMLInputElement
        || active instanceof HTMLTextAreaElement
        || active instanceof HTMLSelectElement;
    };

    const updateAppHeight = () => {
      if (isTextInputFocused()) return;
      const height = viewport?.height || window.innerHeight;
      document.documentElement.style.setProperty('--nd-pwa-app-height', `${Math.round(height)}px`);
    };

    updateAppHeight();
    viewport?.addEventListener('resize', updateAppHeight);
    viewport?.addEventListener('scroll', updateAppHeight);
    window.addEventListener('resize', updateAppHeight);
    window.addEventListener('orientationchange', updateAppHeight);
    window.addEventListener('focusout', updateAppHeight);

    return () => {
      viewport?.removeEventListener('resize', updateAppHeight);
      viewport?.removeEventListener('scroll', updateAppHeight);
      window.removeEventListener('resize', updateAppHeight);
      window.removeEventListener('orientationchange', updateAppHeight);
      window.removeEventListener('focusout', updateAppHeight);
      document.documentElement.classList.remove('nd-pwa-viewport-lock');
      document.body.classList.remove('nd-pwa-viewport-lock');
    };
  }, [isStandalone]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const state = window.history.state as PwaHistoryState | null;
    if (!state?.ndPwaView) {
      window.history.replaceState({ ...(state ?? {}), ndPwaView: view, ndPwaIndex: 0 }, '');
    } else {
      historyIndexRef.current = state.ndPwaIndex ?? 0;
      setView(normalizePwaView(state.ndPwaView));
    }

    const handlePopState = (event: PopStateEvent) => {
      const nextState = event.state as PwaHistoryState | null;
      if (viewRef.current === 'live-guide') {
        const currentIndex = historyIndexRef.current;
        window.history.pushState({ ndPwaView: 'live-guide', ndPwaIndex: currentIndex }, '');
        window.dispatchEvent(new CustomEvent('nd-live-guide-back-request'));
        return;
      }

      historyIndexRef.current = nextState?.ndPwaIndex ?? 0;
      setView(normalizePwaView(nextState?.ndPwaView));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  // 최초 진입 시 현재 PWA 화면을 브라우저 히스토리에 1회만 등록한다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigateTo = useCallback((nextView: PwaView, options?: { replace?: boolean }) => {
    setView(nextView);
    viewRef.current = nextView;
    if (typeof window === 'undefined') return;

    if (options?.replace) {
      const currentState = window.history.state as PwaHistoryState | null;
      const index = currentState?.ndPwaIndex ?? historyIndexRef.current;
      historyIndexRef.current = index;
      window.history.replaceState({ ...(currentState ?? {}), ndPwaView: nextView, ndPwaIndex: index }, '');
      return;
    }

    const nextIndex = historyIndexRef.current + 1;
    historyIndexRef.current = nextIndex;
    window.history.pushState({ ndPwaView: nextView, ndPwaIndex: nextIndex }, '');
  }, []);

  const goBackToHome = useCallback(() => {
    const currentState = typeof window !== 'undefined'
      ? (window.history.state as PwaHistoryState | null)
      : null;

    if (typeof window !== 'undefined' && currentState?.ndPwaView && (currentState.ndPwaIndex ?? 0) > 0) {
      window.history.back();
      return;
    }

    navigateTo('home', { replace: true });
  }, [navigateTo]);

  const exitToHome = useCallback(() => {
    navigateTo('home', { replace: true });
  }, [navigateTo]);

  const markOnboarded = useCallback(() => {
    try {
      localStorage.setItem('nd-onboarded', '1');
    } catch {}
  }, []);

  const enterHome = useCallback(() => {
    markOnboarded();
    navigateTo('home');
  }, [markOnboarded, navigateTo]);

  const startGuide = useCallback((option: ProblemOption, mode: GuideInputMode = 'camera', files: File[] = []) => {
    setSymptomText('');
    setSelectedCtx(option.context);
    setInitialGuideQuestion(option.question);
    setGuideInputMode(mode);
    setInitialGalleryFiles(files);
    navigateTo('live-guide');
  }, [navigateTo]);

  const appendGalleryFiles = useCallback((files: FileList | File[]) => {
    const nextFiles = Array.from(files).filter(file => file.type.startsWith('image/') || file.type.startsWith('video/'));
    if (!nextFiles.length) return;
    setGalleryFiles(current => [...current, ...nextFiles].slice(0, 8));
  }, []);

  const removeGalleryFile = useCallback((index: number) => {
    setGalleryFiles(current => current.filter((_, i) => i !== index));
  }, []);

  const startGalleryGuide = useCallback(() => {
    const trimmed = symptomText.trim();
    setSelectedCtx(trimmed ? inferGuideContextFromText(trimmed) : DEFAULT_CAMERA_OPTION.context);
    setInitialGuideQuestion(trimmed);
    setGuideInputMode('gallery');
    setInitialGalleryFiles(galleryFiles);
    navigateTo('live-guide');
  }, [galleryFiles, navigateTo, symptomText]);

  // ── 진단 모드 뷰 ──────────────────────────────────────────────────────────
  if (view === 'live-guide') {
    return (
      <LiveGuideMode
        initialContext={selectedCtx}
        initialQuestion={initialGuideQuestion}
        initialInputMode={guideInputMode}
        initialGalleryFiles={initialGalleryFiles}
        onExit={exitToHome}
      />
    );
  }

  // ── Screen 01: 온보딩 ─────────────────────────────────────────────────────
  if (view === 'onboarding') {
    return (
      <div className="nd-pwa-onboarding-page" style={{ background: `linear-gradient(180deg, ${C.brandFaint} 0%, ${C.surface} 60%)`, color: C.ink }}>
        {/* deco blobs */}
        <div style={{ position: 'absolute', top: -120, right: -80, width: 320, height: 320, borderRadius: '50%', background: C.brand, opacity: 0.08, filter: 'blur(40px)', pointerEvents: 'none' }}/>
        <div style={{ position: 'absolute', top: 180, left: -100, width: 240, height: 240, borderRadius: '50%', background: C.accent, opacity: 0.10, filter: 'blur(50px)', pointerEvents: 'none' }}/>

        <div style={{ height: 'max(env(safe-area-inset-top,0px),16px)', flexShrink: 0 }}/>

        {/* 건너뛰기 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 22px' }}>
          <button type="button" onClick={enterHome} style={{ background: 'none', border: 'none', fontSize: 14, color: C.inkSoft, fontWeight: 500, cursor: 'pointer', fontFamily: 'Pretendard, system-ui' }}>건너뛰기</button>
        </div>

        {/* 히어로 */}
        <div className="nd-pwa-onboarding-hero">
          <AppLogo size={72}/>
          <div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999, background: C.brandSoft, color: C.brand, fontSize: 12.5, fontWeight: 700, letterSpacing: -0.2, marginBottom: 14 }}>
              <Sparkles size={13}/>
              AI 진단 도우미
            </div>
            <h1 style={{ margin: 0, fontSize: 34, lineHeight: 1.22, fontWeight: 800, letterSpacing: -1.4 }}>
              수리기사 부르기 전,<br/>
              <span style={{ color: C.brand }}>옆집 컴공생</span>에게<br/>
              먼저 물어보세요
            </h1>
            <p style={{ margin: '14px 0 0', fontSize: 15.5, lineHeight: 1.55, color: C.inkSoft, letterSpacing: -0.3, fontWeight: 500 }}>
              카메라·마이크로 PC 증상을 살펴보고,<br/>
              친구처럼 단계별로 알려드려요.
            </p>
          </div>

          {/* 피처 행 */}
          <div className="nd-pwa-onboarding-features">
            <FeatureRow icon={<Camera size={20}/>}   title="카메라로 PC 화면 진단"    sub="BIOS · 에러 메시지 · 부팅 화면"/>
            <FeatureRow icon={<Mic size={20}/>}      title="비프음으로 하드웨어 진단" sub="삐 — 삐삐 패턴을 인식해요"/>
            <FeatureRow icon={<Sparkles size={20}/>} title="증상 단서를 모아 안내해요" sub="처음 보는 화면도 단계별로 확인"/>
          </div>
        </div>

        {/* 하단 CTA */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: `0 22px max(env(safe-area-inset-bottom,0px),24px)`, display: 'flex', flexDirection: 'column', gap: 14, background: `linear-gradient(to top, ${C.surface} 70%, transparent)` }}>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 4 }}>
            <ProgressDot active/>
          </div>
          <PillBtn full onClick={enterHome}>시작하기 <ArrowRight size={18}/></PillBtn>
          <div style={{ textAlign: 'center', fontSize: 13.5, color: C.inkSoft, paddingBottom: 8 }}>
            이미 사용 중이신가요?{' '}
            <span style={{ color: C.brand, fontWeight: 700 }}>로그인</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Screen 03: 증상 입력 ─────────────────────────────────────────────────
  if (view === 'context') {
    const startFreeformGuide = () => {
      const trimmed = symptomText.trim();
      setSelectedCtx(inferGuideContextFromText(trimmed));
      setInitialGuideQuestion(trimmed);
      navigateTo('live-guide', { replace: true });
    };

    return (
      <div className="nd-pwa-context-page" style={{ background: C.bg, color: C.ink }}>
        <div style={{ height: 'max(env(safe-area-inset-top,0px),16px)', flexShrink: 0 }}/>

        {/* 네비 */}
        <div style={{ padding: '6px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <button type="button" onClick={goBackToHome} style={{ width: 40, height: 40, borderRadius: 12, border: 'none', background: C.surface, boxShadow: `inset 0 0 0 1px ${C.line}`, display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke={C.ink} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: C.inkFaint, letterSpacing: 0.3 }}>1 / 3</span>
          <div style={{ width: 40 }}/>
        </div>

        {/* 진행 바 */}
        <div style={{ padding: '3px 22px 0', flexShrink: 0 }}>
          <div style={{ height: 4, borderRadius: 4, background: C.line, position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0, width: '33%', background: C.brand, borderRadius: 4 }}/>
          </div>
        </div>

        {/* 제목 */}
        <div style={{ padding: 'clamp(14px,3.2dvh,22px) 22px 2px', flexShrink: 0 }}>
          <h1 style={{ margin: 0, fontSize: 25, fontWeight: 800, letterSpacing: -1.1, lineHeight: 1.22 }}>어떤 문제가 있나요?</h1>
          <p style={{ margin: '6px 0 0', color: C.inkSoft, fontSize: 14, letterSpacing: -0.3, fontWeight: 500, lineHeight: 1.45 }}>
            보이는 증상이나 궁금한 점을 편하게 적어주세요.<br/>
            비워두고 시작하면 화면 단서부터 먼저 볼게요.
          </p>
        </div>

        {/* 자유 입력 */}
        <div style={{ padding: '12px 22px 0', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <span style={{ color: C.inkSoft, fontSize: 12.5, fontWeight: 600, lineHeight: 1.45 }}>
            사진처럼 화면을 비추면 입력한 내용과 같이 분석해요.
          </span>
          <div style={{ position: 'relative' }}>
            <textarea
              value={symptomText}
              onChange={e => setSymptomText(e.target.value)}
              placeholder={'예: 전원은 들어오는데 모니터에 아무것도 안 떠요\n예: BIOS 화면에서 USB 부팅을 어디서 고르는지 모르겠어요'}
              maxLength={220}
              rows={4}
              style={{
                width: '100%',
                minHeight: 112,
                resize: 'vertical',
                border: 'none',
                borderRadius: 20,
                padding: '14px 16px 30px',
                background: C.surface,
                boxShadow: `inset 0 0 0 1.5px ${C.line}`,
                color: C.ink,
                fontFamily: 'Pretendard, system-ui',
                fontSize: 15.5,
                fontWeight: 600,
                lineHeight: 1.55,
                letterSpacing: -0.3,
                outline: 'none',
              }}
            />
            <span style={{ position: 'absolute', right: 14, bottom: 13, color: C.inkFaint, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', padding: '2px 6px', borderRadius: 999, background: 'rgba(255,255,255,0.86)' }}>
              {symptomText.length}/220
            </span>
          </div>

          <div style={{ marginTop: 4, padding: 12, borderRadius: 16, background: C.surface, boxShadow: `inset 0 0 0 1px ${C.line}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.brand, fontSize: 13, fontWeight: 800 }}>
              <Sparkles size={16}/>
              바로 말하기 어려우면
            </div>
            <p style={{ margin: '8px 0 0', color: C.inkSoft, fontSize: 13.5, lineHeight: 1.5, letterSpacing: -0.2 }}>
              그냥 시작해도 됩니다. 카메라 화면에서 오류 문구, BIOS 메뉴, 불빛 같은 단서를 먼저 보고 물어볼게요.
            </p>
          </div>
        </div>

        {/* 하단 CTA */}
        <div className="nd-pwa-context-cta" style={{ padding: '8px 22px calc(max(env(safe-area-inset-bottom,0px), 18px) + var(--nd-context-cta-lift, 108px))', background: C.bg, display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button type="button" onClick={() => { setSymptomText(''); setInitialGuideQuestion(''); setSelectedCtx('GENERAL'); navigateTo('live-guide', { replace: true }); }} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'Pretendard, system-ui', fontSize: 15, fontWeight: 700, color: C.inkSoft, padding: '8px 16px' }}>
              ✨ 입력 없이 화면부터 보기
            </button>
          </div>
          <PillBtn full onClick={startFreeformGuide}>
            카메라로 분석 시작 <ArrowRight size={18}/>
          </PillBtn>
        </div>
      </div>
    );
  }

  // ── Screen 04: 사진/영상 선택 ─────────────────────────────────────────────
  if (view === 'gallery') {
    const hasFiles = galleryFiles.length > 0;

    return (
      <div className="nd-pwa-gallery-page">
        <div style={{ height: 'max(env(safe-area-inset-top,0px),18px)' }}/>

        <div className="nd-pwa-gallery-nav">
          <button type="button" onClick={goBackToHome} aria-label="뒤로가기">
            <ArrowLeft size={20} aria-hidden="true"/>
          </button>
          <span>사진으로 시작</span>
          <div aria-hidden="true"/>
        </div>

        <div className="nd-pwa-gallery-hero">
          <div className="nd-pwa-gallery-kicker">
            <ImagePlus size={14} aria-hidden="true"/>
            여러 장을 한 번에 확인
          </div>
          <h1>PC 화면 사진을 골라주세요</h1>
          <p>사진과 함께 지금 겪는 증상을 적어두면 화면 단서를 더 정확히 좁혀볼 수 있어요.</p>
        </div>

        <div className="nd-pwa-gallery-panel">
          <button
            type="button"
            className={`nd-pwa-gallery-drop${hasFiles ? ' has-files' : ''}`}
            onClick={() => homeGalleryInputRef.current?.click()}
          >
            <span className="nd-pwa-gallery-drop-icon">
              {hasFiles ? <CheckCircle2 size={26} aria-hidden="true"/> : <ImagePlus size={28} aria-hidden="true"/>}
            </span>
            <strong>{hasFiles ? `${galleryFiles.length}개 선택됨` : '사진/영상 선택'}</strong>
            <span>사진은 여러 장, 영상은 15초 이하를 권장해요.</span>
          </button>

          <input
            ref={homeGalleryInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            style={{ display: 'none' }}
            onChange={e => {
              if (e.currentTarget.files) appendGalleryFiles(e.currentTarget.files);
              e.currentTarget.value = '';
            }}
            aria-hidden="true"
          />

          {hasFiles && (
            <div className="nd-pwa-gallery-list" aria-label="선택한 파일">
              {galleryFiles.map((file, index) => (
                <div key={`${file.name}-${file.lastModified}-${index}`} className="nd-pwa-gallery-file">
                  <span className="nd-pwa-gallery-file-icon">
                    <FileImage size={17} aria-hidden="true"/>
                  </span>
                  <span className="nd-pwa-gallery-file-copy">
                    <strong>{file.name}</strong>
                    <span>{file.type.startsWith('video/') ? '동영상' : '사진'} · {(file.size / 1024 / 1024).toFixed(1)}MB</span>
                  </span>
                  <button type="button" onClick={() => removeGalleryFile(index)} aria-label={`${file.name} 제거`}>
                    <Trash2 size={16} aria-hidden="true"/>
                  </button>
                </div>
              ))}
            </div>
          )}

          <label className="nd-pwa-gallery-symptom" htmlFor="nd-pwa-gallery-symptom-input">
            <span>증상 메모</span>
            <textarea
              id="nd-pwa-gallery-symptom-input"
              value={symptomText}
              onChange={e => setSymptomText(e.target.value)}
              maxLength={220}
              rows={4}
              placeholder={'예: 전원은 들어오는데 화면이 안 떠요\n예: BIOS에서 USB 부팅 메뉴를 못 찾겠어요'}
            />
            <small>{symptomText.length}/220</small>
          </label>

          <div className="nd-pwa-gallery-actions">
            <button type="button" className="nd-pwa-gallery-secondary" onClick={() => homeGalleryInputRef.current?.click()}>
              더 추가
            </button>
            <button type="button" className="nd-pwa-gallery-primary" onClick={startGalleryGuide} disabled={!hasFiles}>
              분석 시작 <ArrowRight size={17} aria-hidden="true"/>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Screen 02: 문제 선택 홈 ───────────────────────────────────────────────
  return (
    <div className="nd-pwa-intake-page">
      <div style={{ height: 'max(env(safe-area-inset-top,0px),16px)', flexShrink: 0 }}/>

      {/* 탑바 */}
      <div className="nd-pwa-intake-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <AppLogo size={32}/>
          <AppWordmark size={18}/>
        </div>
      </div>

      <div className="nd-pwa-intake-hero">
        <h1>무슨 문제를 도와드릴까요?</h1>
        <p>문제를 고르면 화면을 보면서 다음 조치를 안내합니다.</p>
        <div className="nd-pwa-intake-examples" aria-label="예시 증상">
          {HERO_QUICK_OPTIONS.map(option => (
            <span
              key={option.id}
              className="nd-pwa-intake-example-btn"
            >
              <span className="nd-pwa-intake-example-icon">{option.icon}</span>
              <span>
                <strong>{option.title}</strong>
                <small>{option.sub}</small>
              </span>
            </span>
          ))}
        </div>
      </div>

      <div className="nd-pwa-intake-mascot" aria-hidden="true">
        <img src="/brand-mascot.png" alt="" />
      </div>

      <div className="nd-pwa-intake-sheet">
        <div className="nd-pwa-intake-sheet-head">
          <div>
            <strong>작업 선택</strong>
            <span>나중에 카메라 화면에서도 바꿀 수 있어요.</span>
          </div>
          <Monitor size={20} aria-hidden="true"/>
        </div>

        <div className="nd-pwa-problem-list">
          {PROBLEM_OPTIONS.map(option => (
            <button
              key={option.id}
              type="button"
              className="nd-pwa-problem-option"
              onClick={() => startGuide(option)}
            >
              <span className="nd-pwa-problem-icon">{option.icon}</span>
              <span className="nd-pwa-problem-copy">
                <strong>{option.title}</strong>
                <span>{option.sub}</span>
              </span>
              <ArrowRight size={18} aria-hidden="true"/>
            </button>
          ))}
        </div>

        <div className="nd-pwa-direct-row">
          <button type="button" onClick={() => navigateTo('context')}>
            <Wrench size={16} aria-hidden="true"/>
            직접 증상 입력
          </button>
          <button type="button" onClick={() => { setGalleryFiles([]); setSymptomText(''); navigateTo('gallery'); }}>
            <ImagePlus size={16} aria-hidden="true"/>
            사진/영상으로 시작
          </button>
        </div>

        <button
          type="button"
          className="nd-pwa-primary-start"
          onClick={() => startGuide(DEFAULT_CAMERA_OPTION)}
        >
          <Camera size={19} aria-hidden="true"/>
          일단 화면부터 보기
        </button>
      </div>

      <div className="nd-pwa-intake-assurance">
        <div>
          <Sparkles size={16} aria-hidden="true"/>
          <span>잘 모르겠다면 화면을 비추는 것부터 시작하세요.</span>
        </div>
        <div>
          <Mic size={16} aria-hidden="true"/>
          <span>비프음이나 깜빡임은 촬영 중에 같이 확인할 수 있어요.</span>
        </div>
      </div>

      {/* TODO: Phase 10에서 실제 이력 연결 */}
    </div>
  );
}
