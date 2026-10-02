import { DeadlineError } from "@/lib/portfolio/deadline";
export type Vendor = "birdeye" | "helius" | "triton";

export type VendorErrorKind =
  | "http"
  | "network"
  | "timeout"
  | "shape"
  | "api"
  | "auth"
  | "config";

type VendorErrorFields = {
  vendor: Vendor;
  kind: VendorErrorKind;
  path: string;
  message: string;
  status?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  cause?: unknown;
};

export class VendorError extends Error {
  readonly vendor: Vendor;
  readonly kind: VendorErrorKind;
  readonly path: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(fields: VendorErrorFields) {
    super(fields.message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "VendorError";
    this.vendor = fields.vendor;
    this.kind = fields.kind;
    this.path = fields.path;
    this.status = fields.status;
    this.retryable = fields.retryable ?? false;
    this.retryAfterMs = fields.retryAfterMs;
  }
}

export class ProviderAuthError extends VendorError {
  constructor(fields: Omit<VendorErrorFields, "kind" | "retryable">) {
    super({ ...fields, kind: "auth", retryable: false });
    this.name = "ProviderAuthError";
  }
}

export function describeError(e: unknown): string {
  if (e instanceof VendorError) {
    const parts = [`vendor=${e.vendor}`, `kind=${e.kind}`];
    if (e.status !== undefined) parts.push(`status=${e.status}`);
    parts.push(`path=${e.path}`, `retryable=${e.retryable}`);
    return `${parts.join(" ")}: ${e.message}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export function mapError(
  e: unknown,
  fallback: string,
): { status: 502; error: string } {
  if (e instanceof DeadlineError) {
    console.error("portfolio: request deadline:", describeError(e));
    return {
      status: 502,
      error: "Request exceeded its time budget; retry shortly.",
    };
  }
  if (
    e instanceof ProviderAuthError ||
    (e instanceof VendorError && e.kind === "config")
  ) {
    console.error("portfolio: provider unavailable:", describeError(e));
    return { status: 502, error: "Upstream data provider unavailable." };
  }
  console.error("portfolio: request failed:", describeError(e));
  return { status: 502, error: fallback };
}
