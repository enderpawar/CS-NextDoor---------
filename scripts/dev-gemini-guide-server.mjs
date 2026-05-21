import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...valueParts] = trimmed.split('=');
    if (!key || process.env[key]) continue;
    process.env[key] = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.PORT || 8080);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const sessions = new Map();

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
}

function writeSse(res, data, eventName) {
  if (eventName) res.write(`event: ${eventName}\n`);
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const line of payload.split(/\r?\n/)) res.write(`data: ${line}\n`);
  res.write('\n');
}

function buildPrompt({ context, cvSummary, ocrRegions = [], userQuestion, taskGoal, history = [] }) {
  const compactOcr = ocrRegions.slice(0, 60).map(region => ({
    id: region.id,
    text: region.text,
    confidence: region.confidence,
    bbox: region.bbox,
  }));

  return `
당신은 '옆집 컴공생' AI입니다. PC 화면을 보고 한국어 존댓말로 한 번에 1단계만 안내하세요.

컨텍스트: ${context}
세션 목표: ${taskGoal || '(없음)'}
사용자 질문: ${userQuestion || '(없음)'}
OpenCV 요약: ${cvSummary || '(없음)'}
이전 대화: ${JSON.stringify(history.slice(-6))}
OCR 후보 영역(JSON, 원본 프레임 좌표): ${JSON.stringify(compactOcr)}

규칙:
- JSON으로만 응답하세요. 코드블록 금지.
- 형식: {"message":"2~4문장 한국어","overlay":null 또는 {"targetId":"ocr-line-3","label":"여기를 클릭하세요!","reason":"이유","bbox":{"x":120,"y":640,"w":260,"h":44,"unit":"normalized1000"}}}
- overlay는 지금 사용자가 실제로 눌러야 하는 버튼/메뉴 행 하나만 지정하세요.
- 부팅 순서 변경 목표라면 보통 "Boot Option #1" 또는 첫 번째 Boot Priority 행을 지정하세요. BIOS 이미지 전체나 큰 패널을 지정하지 마세요.
- bbox는 반드시 원본 이미지 전체를 1000x1000으로 정규화한 좌표(normalized1000)로, 실제 클릭할 텍스트 행/버튼만 감싸세요.
- OCR 후보가 있으면 targetId도 후보 id 중 하나로 고르세요. OCR이 부정확하면 targetId 없이 bbox만 제공해도 됩니다.
- 데이터 손실 가능 조작은 먼저 짧게 경고하세요.
`.trim();
}

function parseModelJson(text, ocrRegions) {
  const cleaned = (text || '').replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    const message = cleaned || '화면을 다시 비춰주세요.';
    return { message, overlay: recoverOverlayFromMessage(message, ocrRegions) };
  }

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const knownIds = new Set(ocrRegions.map(region => region.id));
    const validOverlay = parsed.overlay && knownIds.has(parsed.overlay.targetId)
      ? {
          targetId: parsed.overlay.targetId,
          label: '여기를 클릭하세요!',
          reason: parsed.overlay.reason,
          bbox: normalizeOverlayBbox(parsed.overlay.bbox),
        }
      : null;
    const message = parsed.message || '화면을 다시 비춰주세요.';
    const overlayHint = [message, parsed.overlay?.label, parsed.overlay?.reason].filter(Boolean).join(' ');
    const visionBbox = normalizeOverlayBbox(parsed.overlay?.bbox);
    const visionOverlay = visionBbox
      ? {
          label: '여기를 클릭하세요!',
          reason: parsed.overlay.reason || 'Gemini Vision이 직접 지정한 클릭 영역입니다.',
          bbox: visionBbox,
        }
      : null;
    return { message, overlay: validOverlay || visionOverlay || recoverOverlayFromMessage(overlayHint, ocrRegions) };
  } catch {
    const message = cleaned || '화면을 다시 비춰주세요.';
    return { message, overlay: recoverOverlayFromMessage(message, ocrRegions) };
  }
}

function normalizeOverlayBbox(bbox) {
  if (!bbox || typeof bbox !== 'object') return undefined;
  // 프롬프트는 normalized1000만 허용 — pixel/normalized01이 오면 clamp가 좌표를 망가뜨리므로 거부.
  const unit = bbox.unit ?? 'normalized1000';
  if (unit !== 'normalized1000') return undefined;
  const x = Number(bbox.x);
  const y = Number(bbox.y);
  const w = Number(bbox.w);
  const h = Number(bbox.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return undefined;
  return {
    x: Math.max(0, Math.min(1000, x)),
    y: Math.max(0, Math.min(1000, y)),
    w: Math.max(1, Math.min(1000, w)),
    h: Math.max(1, Math.min(1000, h)),
    unit,
  };
}

function normalizeTargetText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}# ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function recoverOverlayFromMessage(message, ocrRegions) {
  if (!Array.isArray(ocrRegions) || ocrRegions.length === 0) return null;

  const haystack = normalizeTargetText(message);
  const actionKeywords = [
    'boot', 'secure', 'usb', 'save', 'exit', 'install', 'setup', 'advanced',
    'option', 'priority', 'windows', 'yes', 'ok', 'f10', 'del', 'enabled', 'disabled',
  ];
  let best = null;

  for (const region of ocrRegions) {
    const text = normalizeTargetText(region.text);
    if (text.length < 2) continue;
    let score = Number(region.confidence || 0) * 10;

    if (text.length >= 4 && haystack.includes(text)) score += 80 + Math.min(text.length, 30);
    for (const token of text.split(' ')) {
      if (token.length >= 4 && haystack.includes(token)) score += 18;
    }
    for (const keyword of actionKeywords) {
      if (text.includes(keyword)) score += 10;
      if (haystack.includes(keyword) && text.includes(keyword)) score += 18;
    }

    if (!best || score > best.score) best = { region, score };
  }

  if (!best) return null;
  if (best.score < 18 && ocrRegions.length > 0) best = { region: ocrRegions[0], score: best.score };

  return {
    targetId: best.region.id,
    label: '여기를 클릭하세요!',
    reason: best.score >= 18 ? '응답 텍스트와 OCR 후보를 매칭했습니다.' : 'OCR 후보 중 첫 번째 클릭 후보입니다.',
  };
}

async function callGemini({ frameBase64, prompt }) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: frameBase64 } },
        ],
      }],
      generationConfig: {
        temperature: 0.25,
        responseMimeType: 'application/json',
      },
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `Gemini API HTTP ${response.status}`);
  }
  return body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});

    if (req.method === 'GET' && req.url === '/api/health') {
      return sendJson(res, 200, { status: 'ok', runtime: 'node-dev-gemini', timestamp: new Date().toISOString() });
    }

    if (req.method === 'GET' && req.url === '/api/health/llm') {
      return sendJson(res, 200, {
        status: GEMINI_API_KEY ? 'configured' : 'missing_api_key',
        provider: 'gemini',
        model: GEMINI_MODEL,
        apiKeyConfigured: Boolean(GEMINI_API_KEY),
        runtime: 'node-dev-gemini',
        timestamp: new Date().toISOString(),
      });
    }

    if (req.method === 'POST' && req.url === '/api/guide/start') {
      const body = await readJson(req);
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { context: body.context || 'GENERAL', createdAt: Date.now() });
      return sendJson(res, 200, { sessionId });
    }

    const frameMatch = req.url?.match(/^\/api\/guide\/([^/]+)\/frame$/);
    if (req.method === 'POST' && frameMatch) {
      const session = sessions.get(frameMatch[1]);
      if (!session) return sendJson(res, 404, { error: '가이드 세션을 찾을 수 없어요.' });

      const body = await readJson(req);
      sseHeaders(res);
      try {
        const prompt = buildPrompt({ context: session.context, ...body });
        const raw = await callGemini({ frameBase64: body.frameBase64, prompt });
        const parsed = parseModelJson(raw, body.ocrRegions || []);
        writeSse(res, parsed.message);
        if (parsed.overlay) writeSse(res, parsed.overlay, 'overlay');
        writeSse(res, '[DONE]');
      } catch (error) {
        writeSse(res, `오류가 발생했어요: ${error.message}`);
        writeSse(res, '[DONE]');
      }
      return res.end();
    }

    const deleteMatch = req.url?.match(/^\/api\/guide\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      sessions.delete(deleteMatch[1]);
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`[dev-gemini-guide] listening on http://localhost:${PORT}`);
  console.log(`[dev-gemini-guide] model=${GEMINI_MODEL} apiKeyConfigured=${Boolean(GEMINI_API_KEY)}`);
});
