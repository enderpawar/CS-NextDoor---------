import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { getSystemSnapshot, startMonitoring } from './modules/systemMonitor';
import { getEventLogs } from './modules/eventLogReader';
import { getTopProcesses } from './modules/processAnalyzer';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), // TS 빌드 후 .js 출력
      contextIsolation: true,  // 보안: 필수
      nodeIntegration: false,  // 보안: 필수
    },
  });

  const isDev = process.env.NODE_ENV === 'development';
  win.loadURL(
    isDev
      ? 'http://localhost:3000'
      : `file://${path.join(__dirname, '../renderer/index.html')}`,
  );

  // Phase 3: CPU 온도 포함 전체 스냅샷 2초마다 푸시
  const stopMonitoring = startMonitoring(win);
  win.on('closed', stopMonitoring);
}

// Phase 2: 1회성 조회
ipcMain.handle('get-system-info', () => getSystemSnapshot());

// Phase 4: Windows 이벤트 로그 조회
ipcMain.handle('get-event-logs', () => getEventLogs(30));

// Phase 4: 상위 프로세스 목록 조회 (CPU / 메모리 기준)
ipcMain.handle('get-top-processes', () => getTopProcesses(10));

// Phase 11: 세션 ID 조회 (스텁 — Phase 11에서 SessionController 연동)
ipcMain.handle('get-session-id', () => null);

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
// macOS: Dock 아이콘 클릭 시 창 재생성
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
