import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeError,
  mapError,
  ProviderAuthError,
  VendorError,
} from "@/lib/portfolio/errors";

describe("VendorError", () => {
  it("carries structured fields and defaults retryable to false", () => {
    const e = new VendorError({
      vendor: "birdeye",
      kind: "http",
      path: "/defi/price",
      message: "HTTP 500",
      status: 500,
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("VendorError");
    expect(e.vendor).toBe("birdeye");
    expect(e.kind).toBe("http");
    expect(e.status).toBe(500);
    expect(e.retryable).toBe(false);
  });

  it("preserves the cause", () => {
    const cause = new TypeError("fetch failed");
    const e = new VendorError({
      vendor: "helius",
      kind: "network",
      path: "/v0/x",
      message: "network",
      retryable: true,
      cause,
    });
    expect(e.cause).toBe(cause);
    expect(e.retryable).toBe(true);
  });
});

describe("ProviderAuthError", () => {
  it("is a non-retryable VendorError of kind auth", () => {
    const e = new ProviderAuthError({
      vendor: "helius",
      path: "/v0/addresses",
      message: "HTTP 401",
      status: 401,
    });
    expect(e).toBeInstanceOf(VendorError);
    expect(e).toBeInstanceOf(ProviderAuthError);
    expect(e.name).toBe("ProviderAuthError");
    expect(e.kind).toBe("auth");
    expect(e.retryable).toBe(false);
  });
});

describe("describeError", () => {
  it("renders vendor fields for VendorError", () => {
    const line = describeError(
      new VendorError({
        vendor: "birdeye",
        kind: "http",
        path: "/defi/price",
        message: "HTTP 429",
        status: 429,
        retryable: true,
      }),
    );
    expect(line).toBe(
      "vendor=birdeye kind=http status=429 path=/defi/price retryable=true: HTTP 429",
    );
  });

  it("omits status when absent", () => {
    const line = describeError(
      new VendorError({
        vendor: "helius",
        kind: "network",
        path: "/v0/x",
        message: "fetch failed",
      }),
    );
    expect(line).toBe(
      "vendor=helius kind=network path=/v0/x retryable=false: fetch failed",
    );
  });

  it("falls back to message or String for other values", () => {
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError("str")).toBe("str");
    expect(describeError(undefined)).toBe("undefined");
  });
});

describe("mapError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps ProviderAuthError to the provider-unavailable message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = new ProviderAuthError({
      vendor: "helius",
      path: "/v0/x",
      message: "HTTP 403",
      status: 403,
    });
    expect(mapError(e, "fallback")).toEqual({
      status: 502,
      error: "Upstream data provider unavailable.",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][1])).toContain("kind=auth");
  });

  it("maps every other value to 502 with the fallback message", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const vendor = new VendorError({
      vendor: "birdeye",
      kind: "http",
      path: "/p",
      message: "HTTP 500",
      status: 500,
    });
    for (const e of [vendor, new Error("x"), "str", undefined]) {
      expect(mapError(e, "fallback")).toEqual({
        status: 502,
        error: "fallback",
      });
    }
  });
});
