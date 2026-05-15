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

import { useState } from 'react';
import type { BiosType } from '../../types';
import '../../styles/mobile.css';
import LiveGuideMode    from './LiveGuideMode';
import BiosTypeSelector from './BiosTypeSelector';
import AudioCapture     from './AudioCapture';

type PwaView = 'home' | 'live-guide' | 'audio-capture';

interface Props {
  isStandalone: boolean;  // URL에 ?session= 없음 (PC 부팅 불가 진입)
}

export default function PwaPage({ isStandalone }: Props) {
  const [view,     setView]     = useState<PwaView>('home');
  const [biosType, setBiosType] = useState<BiosType | null>(null);

  if (view === 'live-guide') {
    return <LiveGuideMode />;
  }

  if (view === 'audio-capture') {
    return (
      <div className="nd-pwa-page">
        <div className="nd-pwa-header">
          <button
            type="button"
            onClick={() => setView('home')}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: '1.2rem', padding: '0.2rem 0.4rem', borderRadius: '8px',
            }}
            aria-label="홈으로"
          >
            ←
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
      {/* 헤더 */}
      <div className="nd-pwa-header">
        <div className="nd-pwa-logo-mark">옆</div>
        <div className="nd-pwa-header-text">
          <span className="nd-pwa-app-name">옆집 컴공생</span>
          <span className="nd-pwa-app-sub">PC 하드웨어 진단 도우미</span>
        </div>
      </div>

      {/* 독립 모드 경고 */}
      {isStandalone && (
        <div className="nd-standalone-warn" role="alert">
          <span>⚠️</span>
          <span>
            PC가 부팅된 상태에서 Electron 앱을 먼저 실행하면 SW 데이터를 함께 분석할 수 있어요.
            지금은 하드웨어 진단만 가능해요.
          </span>
        </div>
      )}

      {/* 기능 카드 */}
      <div className="nd-pwa-mode-card">
        <div className="nd-pwa-mode-label">하드웨어 진단</div>
        <p style={{ fontSize: '0.83rem', color: 'var(--color-text-secondary)', margin: '0 0 0.75rem' }}>
          카메라로 PC 화면이나 내부를 비추면 AI가 단계별로 안내해드려요.
        </p>
        <div className="nd-pwa-action-list">
          <button
            type="button"
            className="nd-pwa-action-btn"
            onClick={() => setView('live-guide')}
          >
            <span className="nd-pwa-action-icon">📷</span>
            <div className="nd-pwa-action-text">
              <span className="nd-pwa-action-title">라이브 카메라 가이드</span>
              <span className="nd-pwa-action-desc">
                BIOS 설정, Windows 설치, 부팅 문제 실시간 안내
              </span>
            </div>
          </button>

          <button
            type="button"
            className="nd-pwa-action-btn"
            onClick={() => setView('audio-capture')}
          >
            <span className="nd-pwa-action-icon">🔊</span>
            <div className="nd-pwa-action-text">
              <span className="nd-pwa-action-title">비프음 진단</span>
              <span className="nd-pwa-action-desc">
                부팅 오류 비프음 패턴으로 RAM·메인보드 문제 분석
              </span>
            </div>
          </button>
        </div>
      </div>

      {/* 하단 안내 */}
      <p
        style={{
          fontSize: '0.73rem',
          color: 'var(--color-text-hint, #8e95aa)',
          textAlign: 'center',
          lineHeight: 1.6,
        }}
      >
        카메라·마이크 접근 권한이 필요해요.
        <br />
        HTTPS 환경 또는 localhost에서만 동작해요.
      </p>
    </div>
  );
}
