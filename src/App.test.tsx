import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';

// SystemDashboard는 useSystemInfo에 의존 → App 단위 테스트에서 분리
vi.mock('./hooks/useSystemInfo', () => ({ useSystemInfo: () => null }));

// PwaPage는 카메라·OpenCV·Gemini 의존 → App 라우팅 테스트에서 분리
vi.mock('./components/mobile/PwaPage', () => ({
  default: ({ isStandalone }: { isStandalone: boolean }) => (
    <div data-testid="pwa-page">
      {isStandalone && (
        <div role="alert">하드웨어 진단만 가능해요.</div>
      )}
    </div>
  ),
}));

describe('App — 런타임 모드 배지', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'location', {
      value: { search: '' },
      writable: true,
      configurable: true,
    });
  });

  it('PWA standalone 모드에서 경고 카드 표시', () => {
    render(<App />);
    expect(screen.getByText(/하드웨어 진단만 가능/)).toBeInTheDocument();
  });

  it('Electron 모드에서 PC 시스템 진단 UI 표시', () => {
    Object.defineProperty(window, 'electronAPI', {
      value: {
        getSystemInfo: vi.fn(),
        getTopProcesses: vi.fn().mockResolvedValue({ byCpu: [], byMem: [], total: 0 }),
        getEventLogs: vi.fn().mockResolvedValue([]),
      },
      writable: true,
      configurable: true,
    });
    render(<App />);
    expect(screen.getByRole('heading', { name: '지금 PC 증상을 알려주세요' })).toBeInTheDocument();
  });
});

describe('App — 클립보드 이미지 붙여넣기', () => {
  beforeEach(() => {
    // 클립보드 붙여넣기는 Electron 전용 기능 — electronAPI mock 필요
    Object.defineProperty(window, 'electronAPI', {
      value: {
        getSystemInfo: vi.fn(),
        getTopProcesses: vi.fn().mockResolvedValue({ byCpu: [], byMem: [], total: 0 }),
        getEventLogs: vi.fn().mockResolvedValue([]),
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'location', {
      value: { search: '' },
      writable: true,
      configurable: true,
    });
  });

  it('이미지 아닌 클립보드 데이터는 무시', () => {
    render(<App />);
    const textarea = screen.getByPlaceholderText(/영상 편집/i);

    const clipboardEvent = new Event('paste', { bubbles: true }) as ClipboardEvent;
    Object.defineProperty(clipboardEvent, 'clipboardData', {
      value: {
        items: [{ type: 'text/plain', getAsFile: () => null }],
      },
    });

    fireEvent(textarea, clipboardEvent);
    expect(screen.queryByAltText('첨부 이미지')).not.toBeInTheDocument();
  });

  it('이미지 제거 버튼 클릭 시 썸네일 삭제', async () => {
    render(<App />);

    // FileReader를 class 문법으로 mock (vi.spyOn은 constructor 지원 안 함)
    const DATA_URL = 'data:image/png;base64,abc';
    class MockFileReader {
      onload: ((ev: ProgressEvent<FileReader>) => void) | null = null;
      readAsDataURL() {
        this.onload?.({ target: { result: DATA_URL } } as ProgressEvent<FileReader>);
      }
    }
    vi.stubGlobal('FileReader', MockFileReader);

    const textarea = screen.getByPlaceholderText(/영상 편집/i);
    const mockFile = new File([''], 'screenshot.png', { type: 'image/png' });
    const clipboardEvent = new Event('paste', { bubbles: true }) as ClipboardEvent;
    Object.defineProperty(clipboardEvent, 'clipboardData', {
      value: { items: [{ type: 'image/png', getAsFile: () => mockFile }] },
      configurable: true,
    });
    Object.defineProperty(clipboardEvent, 'preventDefault', { value: vi.fn() });

    fireEvent(textarea, clipboardEvent);

    // 썸네일 표시 확인 후 제거
    const img = await screen.findByAltText('첨부 이미지');
    expect(img).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '이미지 제거' }));
    expect(screen.queryByAltText('첨부 이미지')).not.toBeInTheDocument();

    vi.unstubAllGlobals();
  });
});
