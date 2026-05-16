const DEFAULT_API_BASE_URL = 'http://localhost:8080';

function normalizeApiBaseUrl(value: string | undefined): string {
  const cleaned = value?.replace(/^\uFEFF/, '').trim().replace(/\/$/, '');
  return cleaned || DEFAULT_API_BASE_URL;
}

export const API_BASE_URL =
  normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

export const USE_MOCK_API = import.meta.env.VITE_USE_MOCK === 'true';
