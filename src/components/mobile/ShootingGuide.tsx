import '../../styles/mobile.css';

const STEPS = [
  '촬영 전 PC 주변 조명을 켜주세요.',
  'PC에서 30~50cm 정도 떨어진 정면에서 촬영하세요.',
  '카메라를 화면/부품에 평행하게 맞춰주세요 (기울기 45° 이내).',
  '촬영 중 손떨림이 없도록 양손으로 기기를 고정하세요.',
  '플래시는 켜면 반사가 생길 수 있어요. 주변 조명으로 대체하세요.',
];

const TIPS = ['20~50cm 거리', '정면 촬영', '조명 ON', '손 고정'];

interface Props {
  onDismiss: () => void;
}

export default function ShootingGuide({ onDismiss }: Props) {
  return (
    <div className="nd-shooting-guide">
      <div className="nd-shooting-guide-title">📷 촬영 가이드</div>
      <div className="nd-shooting-guide-steps">
        {STEPS.map((step, i) => (
          <div key={i} className="nd-shooting-step">
            <span className="nd-shooting-step-num">{i + 1}</span>
            <span>{step}</span>
          </div>
        ))}
      </div>
      <div className="nd-shooting-tips">
        {TIPS.map(tip => (
          <span key={tip} className="nd-shooting-tip-chip">{tip}</span>
        ))}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          marginTop: '0.9rem',
          width: '100%',
          padding: '0.65rem',
          background: 'linear-gradient(135deg, #5a81fa, #446ce4)',
          color: '#fff',
          border: 'none',
          borderRadius: '12px',
          fontWeight: 600,
          fontSize: '0.88rem',
          cursor: 'pointer',
        }}
      >
        이해했어요, 시작할게요
      </button>
    </div>
  );
}
