/**
 * E2E 스크린샷 자동화 스크립트
 *
 * 실행: node scripts/screenshot.mjs
 * 의존: npm run pwa:dev 서버가 먼저 실행 중이어야 함
 *
 * 캡처 대상:
 *  1. PWA 홈 화면
 *  2. LiveGuideMode — GuideContextSelector (컨텍스트 선택)
 *  3. LiveGuideMode — 카메라 가이드 (fake camera)
 *  4. 비프음 진단 화면 (BiosTypeSelector + AudioCapture)
 */

import { chromium } from 'playwright';
import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const OUT_DIR   = join(ROOT, 'docs', 'screenshots');
const PORT      = 3099;
const BASE_URL  = `http://localhost:${PORT}`;

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// ── 개발 서버 기동 ──────────────────────────────────────────────────────────
console.log('▶ Vite 개발 서버 시작 중...');
const vite = spawn(
  'npx',
  ['vite', '--mode', 'pwa', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'pipe', shell: true, windowsHide: true }
);

vite.stdout.on('data', d => process.stdout.write('  [vite] ' + d));
vite.stderr.on('data', d => process.stderr.write('  [vite] ' + d));

// 폴링 방식으로 서버 준비 대기 (stdout 인코딩 문제 우회)
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('서버 시작 타임아웃 (30s)')), 30_000);
  const poll = async () => {
    try {
      const { default: http } = await import('http');
      await new Promise((ok, fail) => {
        const req = http.get(`http://localhost:${PORT}/`, r => { r.resume(); ok(); });
        req.on('error', fail);
        req.setTimeout(1000, () => { req.destroy(); fail(new Error('timeout')); });
      });
      clearTimeout(timeout);
      resolve();
    } catch {
      setTimeout(poll, 1000);
    }
  };
  setTimeout(poll, 3000); // 3초 후 폴링 시작
});
await new Promise(r => setTimeout(r, 1000)); // 추가 안정화
console.log(`✓ 서버 준비: ${BASE_URL}`);

// ── Playwright 설정 ─────────────────────────────────────────────────────────
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',        // 카메라/마이크 권한 자동 허가
    '--use-fake-device-for-media-stream',    // 가상 카메라 스트림 (초록 검정 패턴)
    '--no-sandbox',
    '--disable-web-security',
  ],
});

const context = await browser.newContext({
  viewport:    { width: 390, height: 844 },  // iPhone 14 Pro 해상도
  deviceScaleFactor: 2,                      // Retina 2x
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  permissions: ['camera', 'microphone'],
});

const page = await context.newPage();

// 콘솔 에러만 조용히 무시 (카메라/마이크 관련 경고)
page.on('console', msg => {
  if (msg.type() === 'error') console.error('  [browser error]', msg.text().slice(0, 120));
});

// ── 헬퍼 ───────────────────────────────────────────────────────────────────
async function shot(filename, description) {
  const path = join(OUT_DIR, filename);
  await page.screenshot({ path, fullPage: false });
  console.log(`  📸 ${filename} — ${description}`);
  return path;
}

async function waitAndShot(selector, filename, description) {
  await page.waitForSelector(selector, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);  // 애니메이션 완료 대기
  return shot(filename, description);
}

// ── 1. PWA 홈 화면 ───────────────────────────────────────────────────────────
console.log('\n■ 1. PWA 홈 화면');
await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
// 인트로 애니메이션 3.15초 완료 대기 (App.tsx: setTimeout 3150ms)
await page.waitForTimeout(4000);
await shot('01-pwa-home.png', 'PWA 메인 랜딩 — 독립 모드');

// 독립 모드 경고 확인 후 일반 모드로 재접속 (query param 없음이 standalone)
// isStandalone=true (경고 표시) → 이게 실제 상태이므로 그대로 캡처

// ── 2. LiveGuideMode — GuideContextSelector ──────────────────────────────────
console.log('\n■ 2. LiveGuideMode — GuideContextSelector');
// "라이브 카메라 가이드" 버튼 클릭
const liveGuideBtn = page.locator('button:has-text("라이브 카메라 가이드")');
await liveGuideBtn.click();
await page.waitForTimeout(800);
await shot('02-live-guide-context.png', 'GuideContextSelector — 작업 유형 선택');

// ── 3. ShootingGuide (BIOS 진입 선택 후 표시) ────────────────────────────────
console.log('\n■ 3. ShootingGuide');
// BIOS 진입 카드 클릭 → ShootingGuide 표시
const biosCard = page.locator('.nd-context-card').first();
await biosCard.click();
await page.waitForTimeout(800);
await shot('03-shooting-guide.png', 'ShootingGuide — 촬영 가이드 (BIOS 진입)');

// ── 4. LiveGuideMode — 카메라 활성화 (이해했어요 클릭) ────────────────────────
console.log('\n■ 4. LiveGuideMode — 카메라 뷰');
const startBtn = page.locator('button:has-text("이해했어요"), button:has-text("시작")').first();
const hasStart = await startBtn.isVisible({ timeout: 3000 }).catch(() => false);
if (hasStart) {
  await startBtn.click();
  await page.waitForTimeout(2500); // 카메라 + OpenCV 초기화 대기
  await shot('04-live-guide-camera.png', 'LiveGuideMode — 카메라 가이드 활성');
} else {
  await shot('04-live-guide-camera.png', 'LiveGuideMode — ShootingGuide fallback');
}

// ── 5. 홈으로 돌아가서 비프음 진단 ──────────────────────────────────────────
console.log('\n■ 5. 비프음 진단 화면');
// 뒤로가기 버튼 찾기
const backBtn = page.locator('button[aria-label="홈으로"], button:has-text("←")').first();
const hasBack = await backBtn.isVisible().catch(() => false);
if (hasBack) {
  await backBtn.click();
} else {
  // 직접 홈으로
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
}
await page.waitForTimeout(600);

// 비프음 진단 버튼 클릭
const audioBtn = page.locator('button:has-text("비프음 진단")');
await audioBtn.waitFor({ timeout: 5000 }).catch(() => {});
await audioBtn.click();
await page.waitForTimeout(800);
await shot('05-audio-capture.png', 'AudioCapture — 비프음 진단');

// ── 6. BiosTypeSelector (비프음 화면에 포함됨) ─────────────────────────────
const biosSelector = page.locator('[class*="bios-type"], [class*="biostype"], select, [class*="selector"]').first();
await page.waitForTimeout(300);
await shot('06-bios-type-selector.png', 'BiosTypeSelector — BIOS 제조사 선택');

// ── 데스크톱 뷰 (Electron 진단 랜딩) ─────────────────────────────────────────
console.log('\n■ 7. 데스크톱 뷰 (Electron 시뮬레이션 — ?electron=1)');
await context.close();

// Electron 대시보드는 window.electronAPI 유무로 분기하므로
// 브라우저에서 흉내내기 위해 별도 컨텍스트에서 electronAPI mock 주입
const desktopCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const desktopPage = await desktopCtx.newPage();

// electronAPI를 window에 mock 주입
await desktopPage.addInitScript(() => {
  // @ts-ignore
  window.electronAPI = {
    onSystemUpdate: (cb) => {},
    removeSystemListener: () => {},
    getEventLogs: () => Promise.resolve([]),
    getTopProcesses: () => Promise.resolve([]),
    getSystemInfo: () => Promise.resolve({
      cpu: { model: 'Intel Core i7-13700K', usage: 42, temperature: 68, cores: 16 },
      memory: { total: 32 * 1024, used: 18 * 1024, available: 14 * 1024 },
      gpu: { model: 'NVIDIA RTX 4080', vram: 16384 },
      disk: { total: 1000, used: 450, read: 120, write: 85 },
      os: { platform: 'Windows 11 Pro', version: '23H2', uptime: 86400 },
    }),
    getDisksHealth: () => Promise.resolve([
      { name: 'Samsung 990 Pro 1TB', health: 'Good', temperature: 42, smartStatus: 'PASSED' },
    ]),
  };
});

await desktopPage.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
// 인트로 애니메이션(3.15s) + 렌더링 여유 대기
await desktopPage.waitForTimeout(5000);
// 빈 화면이면 더 대기
const bodyText = await desktopPage.evaluate(() => document.body.innerText.trim().length);
if (bodyText < 20) {
  console.log('  [대기] 화면 렌더링 추가 대기...');
  await desktopPage.waitForTimeout(3000);
}
await desktopPage.screenshot({
  path: join(OUT_DIR, '07-electron-dashboard.png'),
  fullPage: false,
});
console.log('  📸 07-electron-dashboard.png — Electron SW 진단 랜딩');

await desktopCtx.close();

// ── 정리 ────────────────────────────────────────────────────────────────────
await browser.close();
vite.kill();

console.log(`\n✅ 스크린샷 완료 → docs/screenshots/ (${Object.keys({})})`);
console.log(`   경로: ${OUT_DIR}`);
