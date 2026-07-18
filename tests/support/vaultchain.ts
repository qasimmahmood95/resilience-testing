// Plane-aware VaultChain API client. Every request carries an explicit budget
// (AbortSignal.timeout) — a hang is a test failure, never a silent stall.

import { BUDGET_FAST_MS, PLANES, type PlaneName } from './config.js';

/** RFC 9457 problem+json body (VaultChain src/errors.ts). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

export interface VcResponse<T = unknown> {
  status: number;
  /** Parsed JSON body; undefined when the body is empty or not JSON. */
  body: T | undefined;
  contentType: string;
  /** Raw response body size in bytes (drives bandwidth-toxic budget maths). */
  bytes: number;
}

export interface RequestOptions {
  apiKey?: string;
  body?: unknown;
  /** Budget in ms; defaults to BUDGET_FAST_MS. */
  budgetMs?: number;
}

export class VaultChainClient {
  constructor(
    readonly plane: PlaneName,
    private readonly apiKey?: string,
  ) {}

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<VcResponse<T>> {
    const key = opts.apiKey ?? this.apiKey;
    const res = await fetch(`${PLANES[this.plane]}${path}`, {
      method,
      headers: {
        ...(key !== undefined ? { 'x-api-key': key } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
      signal: AbortSignal.timeout(opts.budgetMs ?? BUDGET_FAST_MS),
    });
    const contentType = res.headers.get('content-type') ?? '';
    let body: T | undefined;
    const text = await res.text();
    if (text.length > 0 && contentType.includes('json')) {
      body = JSON.parse(text) as T;
    }
    return { status: res.status, body, contentType, bytes: Buffer.byteLength(text) };
  }

  get<T = unknown>(path: string, opts?: RequestOptions): Promise<VcResponse<T>> {
    return this.request('GET', path, opts);
  }

  post<T = unknown>(path: string, opts?: RequestOptions): Promise<VcResponse<T>> {
    return this.request('POST', path, opts);
  }

  put<T = unknown>(path: string, opts?: RequestOptions): Promise<VcResponse<T>> {
    return this.request('PUT', path, opts);
  }
}
