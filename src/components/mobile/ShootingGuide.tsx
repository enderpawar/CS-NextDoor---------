/**
 * ShootingGuide — Screen 04 (Claude Design 포팅)
 *
 * 모니터 일러스트 + 뷰파인더 코너 마커 + 3 팁 + CTA
 * LiveGuideMode 내부 오버레이로 동작.
 */

import { ArrowLeft, Camera } from 'lucide-react';
import '../../styles/mobile.css';

const C = {
  brand:     'oklch(0.56 0.15 245)',
  brandDeep: 'oklch(0.42 0.16 248)',
  brandSoft: 'oklch(0.96 0.028 245)',
  brandFaint:'oklch(0.985 0.012 245)',
  bg:        'oklch(0.985 0.005 240)',
  surface:   '#ffffff',
  ink:       'oklch(0.20 0.02 245)',
  inkSoft:   'oklch(0.50 0.015 245)',
  inkFaint:  'oklch(0.72 0.012 245)',
  line:      'oklch(0.93 0.008 245)',
} as const;

interface Props {
  onDismiss: () => void;
  onBack?: () => void;
}

function CornerMarker({ pos }: { pos: 'tl' | 'tr' | 'br' | 'bl' }) {
  const size = 22;
  const thick = 3;
  const inset = 18;
  const baseStyle: React.CSSProperties = { position: 'absolute', width: size, height: size };
  const posStyle: Record<string, React.CSSProperties> = {
    tl: { top: inset,  left: inset,  borderTop: `${thick}px solid ${C.brand}`, borderLeft:  `${thick}px solid ${C.brand}`, borderTopLeftRadius: 4 },
    tr: { top: inset,  right: inset, borderTop: `${thick}px solid ${C.brand}`, borderRight: `${thick}px solid ${C.brand}`, borderTopRightRadius: 4 },
    br: { bottom: inset, right: inset, borderBottom: `${thick}px solid ${C.brand}`, borderRight: `${thick}px solid ${C.brand}`, borderBottomRightRadius: 4 },
    bl: { bottom: inset, left: inset,  borderBottom: `${thick}px solid ${C.brand}`, borderLeft:  `${thick}px solid ${C.brand}`, borderBottomLeftRadius: 4 },
  };
  return <div style={{ ...baseStyle, ...posStyle[pos] }}/>;
}

function TipRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, fontWeight: 600, color: C.ink, letterSpacing: -0.3 }}>
      <div style={{ width: 22, height: 22, borderRadius: '50%', background: C.brandSoft, color: C.brand, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      {children}
    </div>
  );
}

export default function ShootingGuide({ onDismiss, onBack }: Props) {
  return (
    <div style={{
      width: '100%', minHeight: '100%', background: C.bg,
      fontFamily: 'Pretendard, system-ui, sans-serif', color: C.ink,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ height: 'max(env(safe-area-inset-top,0px),16px)', flexShrink: 0 }}/>

      {/* 네비 + 진행 */}
      <div style={{ padding: '6px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <button
          type="button"
          onClick={onBack}
          aria-label="뒤로가기"
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            border: 'none',
            background: C.surface,
            boxShadow: `inset 0 0 0 1px ${C.line}`,
            color: C.ink,
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            visibility: onBack ? 'visible' : 'hidden',
          }}
        >
          <ArrowLeft size={20} aria-hidden="true"/>
        </button>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.inkFaint, letterSpacing: 0.3 }}>2 / 3</span>
        <div style={{ width: 40 }}/>
      </div>
      <div style={{ padding: '3px 22px 0', flexShrink: 0 }}>
        <div style={{ height: 4, borderRadius: 4, background: C.line, position: 'relative' }}>
          <div style={{ position: 'absolute', inset: 0, width: '66%', background: C.brand, borderRadius: 4 }}/>
        </div>
      </div>

      {/* 제목 */}
      <div style={{ padding: 'clamp(12px,3dvh,20px) 22px 0', flexShrink: 0 }}>
        <div style={{ display: 'inline-flex', padding: '5px 10px', borderRadius: 999, background: C.brandSoft, color: C.brand, fontSize: 11.5, fontWeight: 800, letterSpacing: 0.3, marginBottom: 10 }}>
          STEP · 촬영 준비
        </div>
        <h1 style={{ margin: 0, fontSize: 25, fontWeight: 800, letterSpacing: -1.1, lineHeight: 1.18 }}>
          PC 화면을<br/>비춰주세요
        </h1>
        <p style={{ margin: '6px 0 0', color: C.inkSoft, fontSize: 14, letterSpacing: -0.3, fontWeight: 500 }}>
          BIOS 글자가 또렷이 보이도록 가까이.
        </p>
      </div>

      {/* 일러스트 — 모니터 + 뷰파인더 */}
      <div style={{ padding: 'clamp(14px,3dvh,20px) 22px 0', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ position: 'relative', flex: 1, borderRadius: 20, background: `linear-gradient(180deg, ${C.brandFaint}, ${C.surface})`, overflow: 'hidden', boxShadow: `inset 0 0 0 1px ${C.line}`, minHeight: 190 }}>

          {/* 모의 PC 모니터 */}
          <div style={{ position: 'absolute', inset: '38px 32px 86px', borderRadius: 10, background: '#0d1117', boxShadow: 'inset 0 0 0 4px #1a1f29, 0 10px 24px rgba(0,0,0,0.18)', overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', color: '#a3b3c2', fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 10, lineHeight: 1.55, letterSpacing: 0.2 }}>
              <div style={{ color: '#5dd1ff' }}>AMI BIOS — Setup Utility</div>
              <div>Boot &nbsp;&nbsp; Advanced &nbsp;&nbsp; Security &nbsp;&nbsp; Exit</div>
              <div style={{ borderTop: '1px solid #1f2733', margin: '8px 0' }}/>
              <div>Boot Option #1 &nbsp;&nbsp; [<span style={{ color: '#9fd6a3' }}>Windows Boot</span>]</div>
              <div>Boot Option #2 &nbsp;&nbsp; [USB HDD]</div>
              <div>Boot Option #3 &nbsp;&nbsp; [Network]</div>
              <div style={{ marginTop: 6, color: '#5d6b7a' }}>↑↓: Select &nbsp; +/-: Change &nbsp; F10: Save</div>
            </div>
          </div>

          {/* 뷰파인더 코너 마커 */}
          <CornerMarker pos="tl"/>
          <CornerMarker pos="tr"/>
          <CornerMarker pos="br"/>
          <CornerMarker pos="bl"/>

          {/* 폰 아이콘 */}
          <div style={{ position: 'absolute', left: '50%', bottom: 12, transform: 'translateX(-50%)', width: 64, height: 96, borderRadius: 14, background: C.surface, boxShadow: `0 12px 30px -10px ${C.brand}66, inset 0 0 0 2px ${C.brand}`, display: 'grid', placeItems: 'center', color: C.brand }}>
            <Camera size={26}/>
          </div>

          {/* 조준선 */}
          <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} width="100%" height="100%">
            <line x1="50%" y1="62%" x2="50%" y2="85%" stroke={C.brand} strokeWidth="1.5" strokeDasharray="3 4" opacity="0.6"/>
          </svg>
        </div>

        {/* 팁 */}
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7, flexShrink: 0 }}>
          <TipRow>화면 전체가 가득 차게</TipRow>
          <TipRow>밝은 곳에서 촬영해주세요</TipRow>
          <TipRow>흔들리지 않게 5초 고정</TipRow>
        </div>
      </div>

      {/* CTA */}
      <div style={{ padding: `10px 22px max(env(safe-area-inset-bottom,0px),18px)`, flexShrink: 0 }}>
        <button type="button" onClick={onDismiss} style={{ width: '100%', height: 56, borderRadius: 28, border: 'none', background: C.brand, color: '#fff', fontFamily: 'Pretendard, system-ui', fontWeight: 800, fontSize: 17, letterSpacing: -0.3, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, boxShadow: `0 8px 20px -8px ${C.brand}88` }}>
          <Camera size={18}/>
          촬영 시작하기
        </button>
      </div>
    </div>
  );
}
