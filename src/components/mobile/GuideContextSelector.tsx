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
    context: 'BIOS_ENTRY',
    icon:    '⌨️',
    title:   'BIOS 진입',
    desc:    'Del / F2 키로 BIOS 설정 화면 열기',
  },
  {
    context: 'BOOT_MENU',
    icon:    '💾',
    title:   '부팅 메뉴',
    desc:    'USB·SSD 부팅 순서 변경',
  },
  {
    context: 'WINDOWS_INSTALL',
    icon:    '🪟',
    title:   'Windows 설치',
    desc:    '파티션 설정 → 드라이버 설치',
  },
  {
    context: 'BIOS_RESET',
    icon:    '🔄',
    title:   'BIOS 초기화',
    desc:    'Load Defaults 위치 찾기',
  },
  {
    context: 'SECURE_BOOT',
    icon:    '🔒',
    title:   'Secure Boot',
    desc:    'CSM / Secure Boot 설정 변경',
  },
];

interface Props {
  onSelect: (context: GuideContext) => void;
}

export default function GuideContextSelector({ onSelect }: Props) {
  return (
    <div>
      <p
        style={{
          fontSize: '0.82rem',
          color: 'var(--color-text-secondary, #5d6274)',
          marginBottom: '0.75rem',
        }}
      >
        어떤 작업을 도와드릴까요?
      </p>
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
