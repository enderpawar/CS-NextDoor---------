const DEFAULT_API_BASE_URL = 'http://localhost:8080';

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? DEFAULT_API_BASE_URL;

export const USE_MOCK_API = import.meta.env.VITE_USE_MOCK === 'true';
