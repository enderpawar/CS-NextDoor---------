/**
 * GoalInputSheet
 *
 * "어떤 작업을 도와드릴까요?" — 사용자가 명시적으로 목표를 선언하는 입력 시트.
 * LiveGuideMode 진입 시 자동 오픈되며, 입력된 텍스트는 taskGoalRef에 저장되어
 * Gemini 프롬프트의 "목표-우선 어시스턴트 모드"를 활성화한다.
 *
 * 사용자가 목표를 건너뛰면(잘 모르겠어요) 기존 진단 카테고리 흐름으로 폴백한다.
 */

import { useState } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import '../../styles/mobile.css';

const SUGGESTED_GOALS: { label: string; goal: string }[] = [
  { label: '부팅 순서 바꾸기',     goal: 'BIOS에서 부팅 순서를 USB(또는 다른 디스크) 우선으로 변경하고 싶어요.' },
  { label: 'Secure Boot 끄기',     goal: 'BIOS에서 Secure Boot를 끄고 싶어요.' },
  { label: 'USB로 Windows 설치',   goal: 'USB로 Windows를 설치하려고 해요. 부팅 USB로 진입해서 설치 시작까지 가고 싶어요.' },
  { label: 'BIOS 진입하기',         goal: 'PC를 재시작해서 BIOS 설정 화면으로 들어가고 싶어요.' },
  { label: 'BIOS 기본값 복원',      goal: 'BIOS를 Load Optimized Defaults로 기본값 복원하고 싶어요.' },
  { label: '가상화(VT-x) 켜기',    goal: 'BIOS에서 가상화 기능(VT-x / SVM / Intel VT)을 활성화하고 싶어요.' },
];

interface Props {
  initialGoal?: string;
  onConfirm:   (goal: string) => void;
  onSkip:      () => void;
}

export default function GoalInputSheet({ initialGoal = '', onConfirm, onSkip }: Props) {
  const [draft, setDraft] = useState(initialGoal);
  const trimmed = draft.trim();

  return (
    <>
      <div className="nd-context-sheet-handle" aria-hidden="true" />
      <p className="nd-context-sheet-title nd-goal-sheet-title">
        <Sparkles size={14} aria-hidden="true" /> 어떤 작업을 도와드릴까요?
      </p>
      <p className="nd-goal-sheet-desc">
        목표를 정해주시면 카메라로 비춘 화면을 보면서 한 단계씩 안내해드려요.
      </p>

      <textarea
        className="nd-goal-sheet-input"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        placeholder={'예: BIOS에서 부팅 순서를 USB 우선으로 바꾸고 싶어요'}
        maxLength={160}
        rows={3}
      />
      <div className="nd-goal-sheet-counter">{draft.length}/160</div>

      <div className="nd-goal-sheet-chip-label">자주 묻는 작업</div>
      <div className="nd-goal-sheet-chip-row">
        {SUGGESTED_GOALS.map(opt => (
          <button
            key={opt.label}
            type="button"
            className="nd-goal-sheet-chip"
            onClick={() => setDraft(opt.goal)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="nd-goal-sheet-actions">
        <button
          type="button"
          className="nd-goal-sheet-skip"
          onClick={onSkip}
        >
          잘 모르겠어요 · 자동 진단
        </button>
        <button
          type="button"
          className="nd-goal-sheet-confirm"
          disabled={!trimmed}
          onClick={() => onConfirm(trimmed)}
        >
          이 목표로 시작 <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
