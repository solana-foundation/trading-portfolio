import type { z } from "zod";
import type { Limiter } from "@/lib/portfolio/concurrency";
import {
  ProviderAuthError,
  type Vendor,
  VendorError,
} from "@/lib/portfolio/errors";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BUDGET_MS = 20_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 300;
const BACKOFF_CAP_MS = 4_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429]);
const MAX_ISSUES_IN_MESSAGE = 3;

export type FetchOptions<S extends z.ZodType> = {
  vendor: Vendor;
  schema: S;
  init?: RequestInit;
  signal?: AbortSignal;
  gate?: Limiter;
  attempts?: number;
  budgetMs?: number;
  attemptTimeoutMs?: number;
};

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || status >= 500;
}

export function parseRetryAfter(
  header: string | null,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return undefined;
}

export function backoffDelay(attempt: number, random = Math.random): number {
  return random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: VendorError };

function budgetExhausted(
  vendor: Vendor,
  path: string,
  budgetMs: number,
): Attempt<never> {
  return {
    ok: false,
    error: new VendorError({
      vendor,
      kind: "timeout",
      path,
      message: `request budget of ${budgetMs}ms exhausted while waiting for a vendor slot for ${path}`,
    }),
  };
}

async function runAttempt<S extends z.ZodType>(
  url: string,
  path: string,
  opts: FetchOptions<S>,
  timeoutMs: number,
): Promise<Attempt<z.output<S>>> {
  const { vendor } = opts;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (opts.signal) signals.push(opts.signal);
  let res: Response;
  try {
    res = await fetch(url, { ...opts.init, signal: AbortSignal.any(signals) });
  } catch (cause) {
    if (opts.signal?.aborted) {
      return {
        ok: false,
        error: new VendorError({
          vendor,
          kind: "network",
          path,
          message: `request aborted for ${path}`,
          cause,
        }),
      };
    }
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    return {
      ok: false,
      error: new VendorError({
        vendor,
        kind: timedOut ? "timeout" : "network",
        path,
        message: timedOut
          ? `timeout after ${timeoutMs}ms for ${path}`
          : `network error for ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: true,
        cause,
      }),
    };
  }
  if (!res.ok) {
    const message = `HTTP ${res.status} for ${path}`;
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: new ProviderAuthError({
          vendor,
          path,
          message,
          status: res.status,
        }),
      };
    }
    return {
      ok: false,
      error: new VendorError({
        vendor,
        kind: "http",
        path,
        status: res.status,
        message,
        retryable: isRetryableStatus(res.status),
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      }),
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    return {
      ok: false,
      error: new VendorError({
        vendor,
        kind: "shape",
        path,
        status: res.status,
        message: `response body is not JSON for ${path}`,
        retryable: true,
        cause,
      }),
    };
  }
  const parsed = opts.schema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, MAX_ISSUES_IN_MESSAGE)
      .map((i) => `${i.path.join(".") || "$"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      error: new VendorError({
        vendor,
        kind: "shape",
        path,
        status: res.status,
        message: `unexpected response shape for ${path} (${issues})`,
      }),
    };
  }
  return { ok: true, value: parsed.data };
}

export async function fetchJSON<S extends z.ZodType>(
  url: string,
  opts: FetchOptions<S>,
): Promise<z.output<S>> {
  const path = new URL(url).pathname;
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const gate = opts.gate ?? ((task) => task());
  const started = Date.now();
  let lastError: VendorError | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (budgetMs - (Date.now() - started) <= 0) break;
    const result = await gate(() => {
      const remaining = budgetMs - (Date.now() - started);
      if (remaining <= 0) {
        return Promise.resolve(budgetExhausted(opts.vendor, path, budgetMs));
      }
      return runAttempt(url, path, opts, Math.min(attemptTimeoutMs, remaining));
    });
    if (result.ok) return result.value;
    lastError = result.error;
    if (!result.error.retryable || attempt === attempts - 1) break;
    if (opts.signal?.aborted) break;
    const delay = result.error.retryAfterMs ?? backoffDelay(attempt);
    if (delay > budgetMs - (Date.now() - started)) break;
    await sleep(delay);
  }
  throw (
    lastError ??
    new VendorError({
      vendor: opts.vendor,
      kind: "timeout",
      path,
      message: `request budget of ${budgetMs}ms exhausted for ${path}`,
    })
  );
}
