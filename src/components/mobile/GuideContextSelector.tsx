import '../../styles/mobile.css';
import type { GuideContext } from '../../types';

interface ContextOption {
  context: GuideContext;
  icon:    string;
  title:   string;
  desc:    string;
}

const OPTIONS: ContextOption[] = [
  {
    context: 'GENERAL',
    icon:    '✨',
    title:   '자동 진단',
    desc:    '잘 모르겠으면 화면 단서부터 확인',
  },
  {
    context: 'NO_BOOT',
    icon:    '⏻',
    title:   '부팅 안 됨',
    desc:    '전원·검은 화면·로고 멈춤 확인',
  },
  {
    context: 'SLOW_PC',
    icon:    '↯',
    title:   '느려짐·멈춤',
    desc:    '성능 저하·발열·팬 소음 진단',
  },
  {
    context: 'APP_NOT_OPENING',
    icon:    '▣',
    title:   '실행 안 됨',
    desc:    '앱 오류·설치 실패·무반응 해결',
  },
  {
    context: 'NETWORK_ISSUE',
    icon:    '⌁',
    title:   '인터넷 문제',
    desc:    'Wi-Fi·랜선·DNS·공유기 확인',
  },
  {
    context: 'BLUE_SCREEN',
    icon:    '!',
    title:   '블루스크린',
    desc:    '오류 코드·자동 재부팅 원인 추적',
  },
  {
    context: 'BIOS_BOOT',
    icon:    '⌨',
    title:   'BIOS·부팅 설정',
    desc:    'BIOS 진입·USB 부팅·Secure Boot',
  },
];

interface Props {
  onSelect: (context: GuideContext) => void;
}

export default function GuideContextSelector({ onSelect }: Props) {
  return (
    <div>
      <div className="nd-context-grid">
        {OPTIONS.map(opt => (
          <button
            key={opt.context}
            type="button"
            className="nd-context-card"
            onClick={() => onSelect(opt.context)}
          >
            <span className="nd-context-card-icon">{opt.icon}</span>
            <span className="nd-context-card-title">{opt.title}</span>
            <span className="nd-context-card-desc">{opt.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
