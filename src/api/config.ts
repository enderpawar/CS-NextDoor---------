const DEFAULT_API_BASE_URL = 'http://localhost:8080';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeApiBaseUrl(value: string | undefined): string {
  const cleaned = value?.replace(/^\uFEFF/, '').trim().replace(/\/$/, '');
  if (!cleaned) return DEFAULT_API_BASE_URL;
  if (cleaned.includes('localhost') && typeof window !== 'undefined' && !LOCAL_HOSTS.has(window.location.hostname)) {
    return '';
  }
  return cleaned;
}

export const API_BASE_URL =
  normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

export const USE_MOCK_API = import.meta.env.VITE_USE_MOCK === 'true';
