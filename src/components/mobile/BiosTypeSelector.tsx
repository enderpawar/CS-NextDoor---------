import type { BiosType } from '../../types';
import '../../styles/mobile.css';

const BIOS_OPTIONS: { type: BiosType; icon: string; title: string; desc: string }[] = [
  { type: 'AMI',     icon: '🔵', title: 'AMI UEFI',       desc: 'ASUS, Gigabyte, MSI 등 대부분' },
  { type: 'Award',   icon: '🟡', title: 'Award BIOS',     desc: 'Gigabyte 구형 메인보드' },
  { type: 'Phoenix', icon: '🔴', title: 'Phoenix BIOS',   desc: '노트북 및 일부 브랜드 PC' },
  { type: 'OTHER',   icon: '⚪', title: '기타 / 모름',    desc: '위 항목에 해당 없는 경우' },
];

interface Props {
  selected: BiosType | null;
  onSelect: (type: BiosType) => void;
}

export default function BiosTypeSelector({ selected, onSelect }: Props) {
  return (
    <div className="nd-bios-selector">
      <span className="nd-bios-selector-label">BIOS 제조사 선택</span>
      <p className="nd-bios-selector-hint">
        비프음 패턴은 BIOS 제조사마다 달라요. 부팅 로고 화면에서 확인할 수 있어요.
      </p>
      <div className="nd-bios-grid">
        {BIOS_OPTIONS.map(({ type, icon, title, desc }) => (
          <button
            key={type}
            type="button"
            className={`nd-bios-card${selected === type ? ' selected' : ''}`}
            onClick={() => onSelect(type)}
            aria-pressed={selected === type}
          >
            <span className="nd-bios-card-icon">{icon}</span>
            <span className="nd-bios-card-title">{title}</span>
            <span className="nd-bios-card-desc">{desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
