/**
 * PwaPage — Claude Design 포팅 (옆집 컴공생.html)
 *
 * 화면 흐름: onboarding(01) → home(02) → context(03) → live-guide(05) / audio-capture(06)
 *
 * iOS Safari: 카메라 권한 유지를 위해 페이지 이동 금지.
 * 기능 전환은 state 기반 (페이지 이동 없음).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera, CheckCircle2, History, Mic, ScanLine, Sparkles,
  ArrowRight,
} from 'lucide-react';
import type { BiosType, GuideContext } from '../../types';
import '../../styles/mobile.css';
import LiveGuideMode  from './LiveGuideMode';
import BiosTypeSelector from './BiosTypeSelector';
import AudioCapture   from './AudioCapture';

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
type PwaView = 'onboarding' | 'home' | 'context' | 'live-guide' | 'audio-capture';

interface PwaHistoryState {
  ndPwaView?: PwaView;
  ndPwaIndex?: number;
}

interface Props {
  isStandalone: boolean;
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
  const r = size * 0.28;
  return (
    <div style={{
      width: size, height: size, borderRadius: r, flexShrink: 0,
      background: `linear-gradient(155deg, ${C.brand} 0%, ${C.brandDeep} 100%)`,
      display: 'grid', placeItems: 'center', position: 'relative', overflow: 'hidden',
      boxShadow: `0 ${size * 0.12}px ${size * 0.3}px -${size * 0.1}px ${C.brand}55`,
    }}>
      <div style={{
        width: size * 0.56, height: size * 0.42, borderRadius: size * 0.1,
        background: 'rgba(255,255,255,0.12)',
        border: `${Math.max(1, size * 0.025)}px solid rgba(255,255,255,0.92)`,
        display: 'grid', placeItems: 'center',
      }}>
        <div style={{ width: size * 0.22, height: size * 0.05, borderRadius: size * 0.03, background: '#fff' }}/>
      </div>
      <div style={{
        position: 'absolute', right: size * 0.14, bottom: size * 0.14,
        width: size * 0.2, height: size * 0.2, borderRadius: '50%',
        background: C.accent, boxShadow: `0 0 0 ${size * 0.04}px ${C.brand}`,
      }}/>
    </div>
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

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────

export default function PwaPage({ isStandalone }: Props) {
  const [view,        setView]       = useState<PwaView>(() => {
    try {
      return localStorage.getItem('nd-onboarded') ? 'home' : 'onboarding';
    } catch {
      return 'onboarding';
    }
  });
  const [selectedCtx, setSelectedCtx] = useState<GuideContext | 'beep'>('GENERAL');
  const [symptomText, setSymptomText] = useState('');
  const [initialGuideQuestion, setInitialGuideQuestion] = useState('');
  const [biosType,    setBiosType]   = useState<BiosType | null>(null);
  const [bottomDockOffset, setBottomDockOffset] = useState(0);
  const historyIndexRef = useRef(0);
  const viewRef = useRef<PwaView>(view);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    const isIosLike = /iPad|iPhone|iPod/.test(window.navigator.userAgent)
      || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
    const minBrowserOffset = !isStandalone && isIosLike ? 22 : 0;

    if (!viewport) {
      setBottomDockOffset(minBrowserOffset);
      return;
    }

    const updateBottomDockOffset = () => {
      const occludedBottom = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      setBottomDockOffset(Math.round(Math.max(occludedBottom, minBrowserOffset)));
    };

    updateBottomDockOffset();
    viewport.addEventListener('resize', updateBottomDockOffset);
    viewport.addEventListener('scroll', updateBottomDockOffset);
    window.addEventListener('orientationchange', updateBottomDockOffset);

    return () => {
      viewport.removeEventListener('resize', updateBottomDockOffset);
      viewport.removeEventListener('scroll', updateBottomDockOffset);
      window.removeEventListener('orientationchange', updateBottomDockOffset);
    };
  }, [isStandalone]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const state = window.history.state as PwaHistoryState | null;
    if (!state?.ndPwaView) {
      window.history.replaceState({ ...(state ?? {}), ndPwaView: view, ndPwaIndex: 0 }, '');
    } else {
      historyIndexRef.current = state.ndPwaIndex ?? 0;
      setView(state.ndPwaView);
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
      setView(nextState?.ndPwaView ?? 'home');
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

  const showComingSoon = useCallback(() => {
    window.alert('Phase 10에서 제공될 예정이에요.');
  }, []);

  // ── 진단 모드 뷰 ──────────────────────────────────────────────────────────
  if (view === 'live-guide') {
    return (
      <LiveGuideMode
        initialContext={selectedCtx === 'beep' ? 'GENERAL' : selectedCtx}
        initialQuestion={initialGuideQuestion}
        onExit={exitToHome}
      />
    );
  }

  if (view === 'audio-capture') {
    return (
      <div style={{ minHeight: '100dvh', background: '#0a0f17', fontFamily: 'Pretendard, system-ui', display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 54 }}/>
        <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="button" onClick={goBackToHome} aria-label="홈으로" style={{ width: 40, height: 40, borderRadius: 12, border: 'none', background: 'rgba(255,255,255,0.10)', color: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <span style={{ color: 'rgba(255,255,255,0.65)', fontWeight: 700, fontSize: 13, letterSpacing: 0.3 }}>AUDIO CAPTURE</span>
        </div>
        <div style={{ padding: '0 16px', flex: 1 }}>
          <BiosTypeSelector selected={biosType} onSelect={setBiosType}/>
          <div style={{ marginTop: '0.75rem' }}>
            <AudioCapture biosType={biosType} symptom="부팅 시 비프음 패턴 분석"/>
          </div>
        </div>
      </div>
    );
  }

  // ── Screen 01: 온보딩 ─────────────────────────────────────────────────────
  if (view === 'onboarding') {
    return (
      <div style={{ minHeight: '100dvh', position: 'relative', overflow: 'hidden', background: `linear-gradient(180deg, ${C.brandFaint} 0%, ${C.surface} 60%)`, fontFamily: 'Pretendard, system-ui', color: C.ink, display: 'flex', flexDirection: 'column' }}>
        {/* deco blobs */}
        <div style={{ position: 'absolute', top: -120, right: -80, width: 320, height: 320, borderRadius: '50%', background: C.brand, opacity: 0.08, filter: 'blur(40px)', pointerEvents: 'none' }}/>
        <div style={{ position: 'absolute', top: 180, left: -100, width: 240, height: 240, borderRadius: '50%', background: C.accent, opacity: 0.10, filter: 'blur(50px)', pointerEvents: 'none' }}/>

        <div style={{ height: 54 }}/>

        {/* 건너뛰기 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 22px' }}>
          <button type="button" onClick={enterHome} style={{ background: 'none', border: 'none', fontSize: 14, color: C.inkSoft, fontWeight: 500, cursor: 'pointer', fontFamily: 'Pretendard, system-ui' }}>건너뛰기</button>
        </div>

        {/* 히어로 */}
        <div style={{ padding: '36px 28px 0', display: 'flex', flexDirection: 'column', gap: 22, flex: 1 }}>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 'auto', paddingBottom: 180 }}>
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
      <div style={{ minHeight: '100dvh', background: C.bg, fontFamily: 'Pretendard, system-ui', color: C.ink, display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 54 }}/>

        {/* 네비 */}
        <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button type="button" onClick={goBackToHome} style={{ width: 40, height: 40, borderRadius: 12, border: 'none', background: C.surface, boxShadow: `inset 0 0 0 1px ${C.line}`, display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke={C.ink} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: C.inkFaint, letterSpacing: 0.3 }}>1 / 3</span>
          <div style={{ width: 40 }}/>
        </div>

        {/* 진행 바 */}
        <div style={{ padding: '4px 22px 0' }}>
          <div style={{ height: 4, borderRadius: 4, background: C.line, position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0, width: '33%', background: C.brand, borderRadius: 4 }}/>
          </div>
        </div>

        {/* 제목 */}
        <div style={{ padding: '24px 22px 4px' }}>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: -1.1, lineHeight: 1.25 }}>어떤 문제가 있나요?</h1>
          <p style={{ margin: '8px 0 0', color: C.inkSoft, fontSize: 14.5, letterSpacing: -0.3, fontWeight: 500 }}>
            보이는 증상이나 궁금한 점을 편하게 적어주세요.<br/>
            비워두고 시작하면 화면 단서부터 먼저 볼게요.
          </p>
        </div>

        {/* 자유 입력 */}
        <div style={{ padding: '18px 22px 0', display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
          <span style={{ color: C.inkSoft, fontSize: 12.5, fontWeight: 600, lineHeight: 1.45 }}>
            사진처럼 화면을 비추면 입력한 내용과 같이 분석해요.
          </span>
          <div style={{ position: 'relative' }}>
            <textarea
              value={symptomText}
              onChange={e => setSymptomText(e.target.value)}
              placeholder={'예: 전원은 들어오는데 모니터에 아무것도 안 떠요\n예: BIOS 화면에서 USB 부팅을 어디서 고르는지 모르겠어요'}
              maxLength={220}
              rows={6}
              style={{
                width: '100%',
                minHeight: 150,
                resize: 'vertical',
                border: 'none',
                borderRadius: 20,
                padding: '16px 16px 34px',
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

          <div style={{ marginTop: 8, padding: 14, borderRadius: 18, background: C.surface, boxShadow: `inset 0 0 0 1px ${C.line}` }}>
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
        <div style={{ padding: `calc(12px + ${bottomDockOffset}px) 22px max(env(safe-area-inset-bottom,0px), calc(30px + ${bottomDockOffset}px))`, background: C.bg, display: 'flex', flexDirection: 'column', gap: 10 }}>
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

  // ── Screen 02: 홈 ────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100dvh', background: C.bg, fontFamily: 'Pretendard, system-ui', color: C.ink, display: 'flex', flexDirection: 'column', paddingBottom: `calc(env(safe-area-inset-bottom,0px) + 24px + ${bottomDockOffset}px)` }}>
      <div style={{ height: 54 }}/>

      {/* 탑바 */}
      <div style={{ padding: '8px 22px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <AppLogo size={32}/>
          <AppWordmark size={18} compact/>
        </div>
        <button type="button" onClick={showComingSoon} title="Phase 10 예정" aria-label="히스토리 보기 예정" style={{ width: 40, height: 40, borderRadius: 12, border: 'none', background: C.surface, boxShadow: `inset 0 0 0 1px ${C.line}`, display: 'grid', placeItems: 'center', position: 'relative', color: C.inkSoft, cursor: 'pointer' }}>
          <History size={20}/>
        </button>
      </div>

      {/* 인사 */}
      <div style={{ padding: '24px 22px 12px' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.inkSoft, letterSpacing: -0.3 }}>안녕하세요 👋</div>
        <h1 style={{ margin: '4px 0 0', fontSize: 26, fontWeight: 800, lineHeight: 1.3, letterSpacing: -1.2 }}>
          오늘은<br/>어떤 문제가 있나요?
        </h1>
      </div>

      {/* 메인 CTA 카드 */}
      <div style={{ padding: '12px 22px 0' }}>
        <button type="button" onClick={() => { setSymptomText(''); setInitialGuideQuestion(''); setSelectedCtx('GENERAL'); navigateTo('live-guide'); }} style={{ width: '100%', borderRadius: 24, padding: 18, position: 'relative', overflow: 'hidden', background: `linear-gradient(140deg, ${C.brand} 0%, ${C.brandDeep} 100%)`, color: '#fff', boxShadow: `0 16px 30px -16px ${C.brand}aa`, border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'Pretendard, system-ui' }}>
          {/* 데코 링 */}
          <div style={{ position: 'absolute', right: -50, top: -50, width: 180, height: 180, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.22)', pointerEvents: 'none' }}/>
          <div style={{ position: 'absolute', right: -20, top: -20, width: 120, height: 120, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.16)', pointerEvents: 'none' }}/>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, opacity: 0.85, letterSpacing: 0.4 }}>
            <Sparkles size={12}/>
            화면 단서 분석
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 8, letterSpacing: -0.8 }}>
            PC 화면을 비추면<br/>바로 분석해요
          </div>
          <div style={{ fontSize: 13, opacity: 0.85, marginTop: 6, letterSpacing: -0.2, fontWeight: 500 }}>
            오류 문구, 부팅 화면, 검은 화면 단서를 카메라로 확인합니다
          </div>
          <div style={{ marginTop: 14, height: 44, borderRadius: 22, background: 'rgba(255,255,255,0.96)', color: C.brand, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 15, fontWeight: 800, letterSpacing: -0.3 }}>
            <Camera size={18}/>
            진단 시작하기
          </div>
        </button>
        <button type="button" onClick={() => { setSymptomText(''); setInitialGuideQuestion(''); setSelectedCtx('GENERAL'); navigateTo('context'); }} style={{ width: '100%', marginTop: 12, border: 'none', background: 'transparent', color: C.brand, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, cursor: 'pointer', fontFamily: 'Pretendard, system-ui', fontSize: 13.5, fontWeight: 800, letterSpacing: -0.2 }}>
          증상을 먼저 적고 시작할게요
          <ArrowRight size={17}/>
        </button>
      </div>

      {/* 진단 준비 상태 */}
      <div style={{ padding: '20px 22px 0' }}>
        <div style={{ padding: 16, borderRadius: 20, background: C.surface, boxShadow: `inset 0 0 0 1px ${C.line}`, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: -0.4 }}>화면 진단 준비됨</div>
              <p style={{ margin: '5px 0 0', fontSize: 12.8, lineHeight: 1.45, color: C.inkSoft, fontWeight: 600, letterSpacing: -0.2 }}>
                카메라로 오류 문구와 화면 단서를 확인할 수 있어요.
              </p>
            </div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 8px', borderRadius: 999, background: '#e8f5ee', color: C.ok, fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}>
              <CheckCircle2 size={13}/>
              시작 가능
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <ReadinessItem icon={<Camera size={17}/>} label="카메라" status="화면 단서 확인"/>
            <ReadinessItem icon={<ScanLine size={17}/>} label="화면 읽기" status="문구·메뉴 확인"/>
            <ReadinessItem icon={<Mic size={17}/>} label="마이크" status="비프음 선택 진단"/>
            <ReadinessItem icon={<Sparkles size={17}/>} label="해결 안내" status="단계별 진행"/>
          </div>
        </div>
      </div>

      {/* TODO: Phase 10에서 실제 이력 연결 */}
    </div>
  );
}
