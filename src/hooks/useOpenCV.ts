// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const cv: any;

import { useState, useEffect, useRef } from 'react';

type CvStatus = 'loading' | 'ready' | 'error';

// 모듈 레벨 싱글톤 — 여러 컴포넌트가 mount/unmount해도 1회만 로드
let _cvStatus: CvStatus = 'loading';
const _listeners = new Set<(s: CvStatus) => void>();

function broadcast(s: CvStatus): void {
  _cvStatus = s;
  _listeners.forEach(fn => fn(s));
}

function ensureLoaded(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('opencv-js')) return;

  const script = document.createElement('script');
  script.id = 'opencv-js';
  script.src = '/opencv.js';
  script.async = true;

  script.onload = () => {
    // script.onload 직후에는 WASM 미초기화 — onRuntimeInitialized 필수
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any;
    win.cv = win.cv ?? {};
    win.cv['onRuntimeInitialized'] = () => broadcast('ready');
    // 이미 초기화된 경우 (hot-reload 등)
    if (win.cv?.Mat) broadcast('ready');
  };

  script.onerror = () => broadcast('error');
  document.head.appendChild(script);
}

// 모듈 임포트 시점에 로드 시작 (컴포넌트 마운트 전)
ensureLoaded();

export function useOpenCV(): { cvReady: boolean; cvError: boolean } {
  const [status, setStatus] = useState<CvStatus>(_cvStatus);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;

    if (_cvStatus !== 'loading') {
      setStatus(_cvStatus);
      return;
    }

    const listener = (s: CvStatus) => {
      if (isMounted.current) setStatus(s);
    };
    _listeners.add(listener);

    return () => {
      isMounted.current = false;
      _listeners.delete(listener);
    };
  }, []);

  return { cvReady: status === 'ready', cvError: status === 'error' };
}
