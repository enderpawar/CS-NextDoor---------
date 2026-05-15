import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ElectronDashboard from './ElectronDashboard';
import type { HypothesesResponse } from '../../types';

// ── 공통 props ────────────────────────────────────────────────────────────────

const baseProps = {
  sysInfo: null,
  cpuHistory: [],
  symptom: '',
  clipboardImage: null,
  isLoading: false,
  apiError: null,
  processData: null,
  eventLogs: [],
  diagnosisResponse: null,
  onSymptomChange: vi.fn(),
  onPaste: vi.fn(),
  onDiagnose: vi.fn(),
  onClearImage: vi.fn(),
  onReset: vi.fn(),
};

const MOCK_RESPONSE: HypothesesResponse = {
  diagnosisId: 'test-diag-001',
  immediateAction: '먼지 청소부터 시작해보세요.',
  hypotheses: [
    {
      id: 'hypo-a',
      priority: 'A',
      title: 'CPU 서멀 스로틀링',
      description: '쿨러 팬 먼지 청소 후 온도를 확인하세요.',
      confidence: 0.83,
      status: 'pending',
    },
    {
      id: 'hypo-b',
      priority: 'B',
      title: '백그라운드 프로세스 과다 점유',
      description: '작업 관리자에서 시작 프로그램을 정리하세요.',
      confidence: 0.65,
      status: 'pending',
    },
    {
      id: 'hypo-c',
      priority: 'C',
      title: 'GPU 드라이버 충돌',
      description: 'DDU로 드라이버를 완전 제거 후 재설치하세요.',
      confidence: 0.48,
      status: 'pending',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── 헬퍼: 줌 + 대화 뷰 진입 ──────────────────────────────────────────────────
// 버튼 클릭 → 줌 딜레이(380ms) → 모핑 완료(520ms) 순서로 타이머 진행
async function enterConversation() {
  fireEvent.click(screen.getByRole('button', { name: 'AI 진단 시작하기' }));
  await act(async () => { vi.advanceTimersByTime(400); }); // zoom → showConversationLayout
  await act(async () => { vi.advanceTimersByTime(600); }); // morphing 완료
}

// ── 랜딩 뷰 ──────────────────────────────────────────────────────────────────

describe('ElectronDashboard — 랜딩 뷰', () => {
  it('초기 상태에서 증상 입력 heading이 렌더링된다', () => {
    render(<ElectronDashboard {...baseProps} />);
    expect(screen.getByRole('heading', { name: '지금 PC 증상을 알려주세요' })).toBeInTheDocument();
  });

  it('증상 textarea가 렌더링된다', () => {
    render(<ElectronDashboard {...baseProps} />);
    expect(screen.getByPlaceholderText(/영상 편집/i)).toBeInTheDocument();
  });

  it('사이드바에 3단계 워크플로우만 표시된다', () => {
    render(<ElectronDashboard {...baseProps} />);
    // 워크플로우 step label은 각 1개
    expect(screen.getByText('가설 추적')).toBeInTheDocument();
    expect(screen.getByText('재현 모드')).toBeInTheDocument();
    // Phase 5 단순화 — 패턴 분석·HW 연결 없음
    expect(screen.queryByText('패턴 분석')).not.toBeInTheDocument();
    expect(screen.queryByText('HW 연결')).not.toBeInTheDocument();
  });

  it('현재 1/3 단계가 사이드바에 표시된다', () => {
    render(<ElectronDashboard {...baseProps} />);
    expect(screen.getByText('현재 1/3 단계')).toBeInTheDocument();
  });

  it('증상이 비어 있으면 AI 진단 시작하기 버튼이 비활성화된다', () => {
    render(<ElectronDashboard {...baseProps} symptom="" />);
    expect(screen.getByRole('button', { name: 'AI 진단 시작하기' })).toBeDisabled();
  });

  it('증상이 있으면 AI 진단 시작하기 버튼이 활성화된다', () => {
    render(<ElectronDashboard {...baseProps} symptom="팬 소음이 심해졌어요" />);
    expect(screen.getByRole('button', { name: 'AI 진단 시작하기' })).not.toBeDisabled();
  });
});

// ── 줌 전환 ───────────────────────────────────────────────────────────────────

describe('ElectronDashboard — 줌 전환', () => {
  it('진단 시작 시 onDiagnose가 약 380ms 딜레이 후 호출된다', async () => {
    const onDiagnose = vi.fn();
    render(
      <ElectronDashboard {...baseProps} symptom="팬 소음이 심해졌어요" onDiagnose={onDiagnose} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'AI 진단 시작하기' }));

    // 딜레이 전에는 미호출
    expect(onDiagnose).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(400); });

    expect(onDiagnose).toHaveBeenCalledTimes(1);
  });

  it('진단 시작 후 사용자 메시지가 채팅 피드에 표시된다', async () => {
    render(<ElectronDashboard {...baseProps} symptom="팬 소음이 심해졌어요" />);

    await enterConversation();

    // textarea와 구별하기 위해 채팅 버블 selector 사용
    expect(screen.getByText('팬 소음이 심해졌어요', { selector: '.nd-bubble.user' })).toBeInTheDocument();
  });

  it('전환 후 nd-chat-fullview가 렌더링된다', async () => {
    const { container } = render(
      <ElectronDashboard {...baseProps} symptom="팬 소음이 심해졌어요" />,
    );

    await enterConversation();

    expect(container.querySelector('.nd-chat-fullview')).toBeInTheDocument();
  });

  it('전환 후 랜딩 뷰 heading이 사라진다', async () => {
    render(<ElectronDashboard {...baseProps} symptom="팬 소음이 심해졌어요" />);

    await enterConversation();

    expect(screen.queryByRole('heading', { name: '증상 입력' })).not.toBeInTheDocument();
  });
});

// ── 가설 추적 뷰 ──────────────────────────────────────────────────────────────

describe('ElectronDashboard — 가설 추적 뷰', () => {
  // diagnosisResponse는 진입 후 rerender로 전달 (App.tsx의 실제 흐름과 동일)
  async function enterWithResponse() {
    const utils = render(
      <ElectronDashboard {...baseProps} symptom="팬 소음이 심해졌어요" />,
    );
    await enterConversation();
    utils.rerender(
      <ElectronDashboard
        {...baseProps}
        symptom="팬 소음이 심해졌어요"
        diagnosisResponse={MOCK_RESPONSE}
      />,
    );
    return utils;
  }

  it('isLoading=true 이면 분석 중 메시지가 표시된다', async () => {
    const { rerender } = render(
      <ElectronDashboard {...baseProps} symptom="팬 소음이 심해졌어요" />,
    );
    await enterConversation();
    rerender(
      <ElectronDashboard {...baseProps} symptom="팬 소음이 심해졌어요" isLoading />,
    );
    expect(screen.getByText(/가설을 정리하는 중/)).toBeInTheDocument();
  });

  it('diagnosisResponse 도착 시 가설 카드 3개가 렌더링된다', async () => {
    await enterWithResponse();

    expect(screen.getByText('CPU 서멀 스로틀링')).toBeInTheDocument();
    expect(screen.getByText('백그라운드 프로세스 과다 점유')).toBeInTheDocument();
    expect(screen.getByText('GPU 드라이버 충돌')).toBeInTheDocument();
  });

  it('immediateAction 메시지가 AI 버블에 표시된다', async () => {
    await enterWithResponse();
    expect(screen.getByText('먼지 청소부터 시작해보세요.')).toBeInTheDocument();
  });

  it('현재 2/3 단계로 업데이트된다', async () => {
    await enterWithResponse();
    expect(screen.getByText('현재 2/3 단계')).toBeInTheDocument();
  });

  it('apiError 발생 시 에러 버블이 표시된다', async () => {
    const { rerender } = render(
      <ElectronDashboard {...baseProps} symptom="팬 소음이 심해졌어요" />,
    );
    await enterConversation();
    rerender(
      <ElectronDashboard
        {...baseProps}
        symptom="팬 소음이 심해졌어요"
        apiError="서버에 연결할 수 없습니다"
      />,
    );
    expect(screen.getByText('서버에 연결할 수 없습니다')).toBeInTheDocument();
  });

  it('시스템 상태 스트립이 표시된다', async () => {
    await enterWithResponse();
    // nd-chat-status-strip 안의 "실시간 연결" 레이블
    expect(screen.getByText('실시간 연결')).toBeInTheDocument();
  });
});

// ── 가설 카드 인터랙션 ─────────────────────────────────────────────────────────

describe('ElectronDashboard — 가설 카드 인터랙션', () => {
  async function setup() {
    const utils = render(
      <ElectronDashboard {...baseProps} symptom="팬 소음이 심해졌어요" />,
    );
    await enterConversation();
    utils.rerender(
      <ElectronDashboard
        {...baseProps}
        symptom="팬 소음이 심해졌어요"
        diagnosisResponse={MOCK_RESPONSE}
      />,
    );
    return utils;
  }

  it('"이 조치 시도하기" 클릭 시 해봤어요/효과 없어요 버튼이 나타난다', async () => {
    await setup();
    const tryButtons = screen.getAllByRole('button', { name: '이 조치 시도하기' });
    fireEvent.click(tryButtons[0]!);
    expect(screen.getByRole('button', { name: '해봤어요' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '효과 없어요' })).toBeInTheDocument();
  });

  it('"해봤어요" 클릭 시 해결됐나요 분기 버튼이 나타난다', async () => {
    await setup();
    const tryButtons = screen.getAllByRole('button', { name: '이 조치 시도하기' });
    fireEvent.click(tryButtons[0]!);
    fireEvent.click(screen.getByRole('button', { name: '해봤어요' }));
    expect(screen.getByRole('button', { name: '해결됐어요' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '아직 안 됐어요' })).toBeInTheDocument();
  });

  it('"해봤어요" → "해결됐어요" 클릭 시 완료 pill과 해결됨 카드가 표시된다', async () => {
    await setup();
    const tryButtons = screen.getAllByRole('button', { name: '이 조치 시도하기' });
    fireEvent.click(tryButtons[0]!);
    fireEvent.click(screen.getByRole('button', { name: '해봤어요' }));
    fireEvent.click(screen.getByRole('button', { name: '해결됐어요' }));
    expect(screen.getByText('완료')).toBeInTheDocument();
    expect(screen.getByText('문제가 해결됐군요!')).toBeInTheDocument();
  });

  it('"해봤어요" → "아직 안 됐어요" 클릭 시 추가 점검 필요 pill이 표시된다', async () => {
    await setup();
    const tryButtons = screen.getAllByRole('button', { name: '이 조치 시도하기' });
    fireEvent.click(tryButtons[0]!);
    fireEvent.click(screen.getByRole('button', { name: '해봤어요' }));
    fireEvent.click(screen.getByRole('button', { name: '아직 안 됐어요' }));
    expect(screen.getByText('추가 점검 필요')).toBeInTheDocument();
  });

  it('"효과 없어요" 클릭 시 추가 점검 필요 pill이 표시된다', async () => {
    await setup();
    const tryButtons = screen.getAllByRole('button', { name: '이 조치 시도하기' });
    fireEvent.click(tryButtons[0]!);
    fireEvent.click(screen.getByRole('button', { name: '효과 없어요' }));
    expect(screen.getByText('추가 점검 필요')).toBeInTheDocument();
  });

  it('모든 가설 소진 시 재현 모드 시작하기 버튼이 나타난다', async () => {
    await setup();

    const tryButtons = screen.getAllByRole('button', { name: '이 조치 시도하기' });
    for (const btn of tryButtons) {
      fireEvent.click(btn);
      fireEvent.click(screen.getByRole('button', { name: '효과 없어요' }));
    }

    // fireEvent는 동기적 상태 업데이트 → act만으로 충분
    await act(async () => {});
    expect(screen.getByRole('button', { name: /재현 모드 시작하기/ })).toBeInTheDocument();
  });

  it('모든 가설 소진 시 현재 3/3 단계로 업데이트된다', async () => {
    await setup();

    const tryButtons = screen.getAllByRole('button', { name: '이 조치 시도하기' });
    for (const btn of tryButtons) {
      fireEvent.click(btn);
      fireEvent.click(screen.getByRole('button', { name: '효과 없어요' }));
    }

    await act(async () => {});
    expect(screen.getByText('현재 3/3 단계')).toBeInTheDocument();
  });
});

// ── 새 진단 리셋 ──────────────────────────────────────────────────────────────

describe('ElectronDashboard — 새 진단 리셋', () => {
  async function enterWithResponseAndReset() {
    const onReset = vi.fn();
    const utils = render(
      <ElectronDashboard {...baseProps} symptom="팬 소음이 심해졌어요" onReset={onReset} />,
    );
    await enterConversation();
    utils.rerender(
      <ElectronDashboard
        {...baseProps}
        symptom="팬 소음이 심해졌어요"
        diagnosisResponse={MOCK_RESPONSE}
        onReset={onReset}
      />,
    );
    return { ...utils, onReset };
  }

  it('채팅 뷰의 새 진단 버튼 클릭 시 onReset이 호출된다', async () => {
    const { onReset } = await enterWithResponseAndReset();

    // 채팅 상태 스트립의 "새 진단" 버튼 (topbar의 "새 진단"과 구별)
    const resetBtns = screen.getAllByRole('button', { name: '새 진단' });
    fireEvent.click(resetBtns[0]!);

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('새 진단 후 랜딩 뷰 heading이 다시 표시된다', async () => {
    const { onReset } = await enterWithResponseAndReset();

    const resetBtns = screen.getAllByRole('button', { name: '새 진단' });
    fireEvent.click(resetBtns[0]!);

    // handleReset은 동기적 상태 업데이트
    await act(async () => {});
    expect(screen.getByRole('heading', { name: '지금 PC 증상을 알려주세요' })).toBeInTheDocument();
  });
});
