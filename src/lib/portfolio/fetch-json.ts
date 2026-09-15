const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchJSON<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${new URL(url).pathname}`);
  }
  return res.json() as Promise<T>;
}
