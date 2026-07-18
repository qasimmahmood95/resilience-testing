// Stack endpoints and seeded credentials. Everything here is mock/fictional —
// VaultChain prints these keys in its own seed output on purpose.

/** Traffic planes (Toxiproxy proxies — see ADR-0002 and toxiproxy/proxies.json). */
// 127.0.0.1, not localhost: dual-stack resolution can pay a Happy-Eyeballs
// ::1 fallback (~250ms) on first connect, which would pollute fast-path
// timing assertions with a variable that has nothing to do with the SUT.
export const PLANES = {
  /** CLIENT-actor traffic: the degraded path under test. */
  client: process.env['CLIENT_PLANE_URL'] ?? 'http://127.0.0.1:18000',
  /** OPERATOR / COMPLIANCE_OFFICER traffic: degradable independently. */
  ops: process.env['OPS_PLANE_URL'] ?? 'http://127.0.0.1:18001',
  /** Simulator + ground-truth reads: NEVER toxified. */
  control: process.env['CONTROL_PLANE_URL'] ?? 'http://127.0.0.1:18002',
} as const;

export type PlaneName = keyof typeof PLANES;

/** Toxiproxy admin API. */
export const TOXIPROXY_URL = process.env['TOXIPROXY_URL'] ?? 'http://127.0.0.1:8474';

/** Proxy names as declared in toxiproxy/proxies.json. */
export const PROXY_NAMES = ['client-plane', 'ops-plane', 'control-plane'] as const;
export type ProxyName = (typeof PROXY_NAMES)[number];

/** The one proxy that must never carry a toxic (observation integrity). */
export const NEVER_TOXIFIED: ProxyName = 'control-plane';

/**
 * Deterministic seeded API keys (VaultChain scripts/seed-lib.ts, RNG seed 42).
 * Mock credentials for a fictional platform — safe to commit by design.
 */
export const API_KEYS = {
  admin: 'vck_admin_0000000000000000',
  operatorA: 'vck_operator_a_000000000000',
  operatorB: 'vck_operator_b_000000000000',
  compliance: 'vck_compliance_000000000000',
  client01: 'vck_client_01_0000000000',
  client02: 'vck_client_02_0000000000',
} as const;

/**
 * Request budgets (ms). Derivations:
 * - FAST: healthy in-process SQLite round-trip is <50ms locally; 2000ms gives
 *   40x headroom for CI noise while still failing a genuinely stuck request.
 * - DEGRADED ceiling for M2+ toxic tests is defined per-scenario next to its
 *   toxic parameters, not here.
 */
export const BUDGET_FAST_MS = 2_000;

/**
 * FAST_PATH_CEILING_MS: what "undegraded" means in timing assertions.
 * Derivation: healthy round-trip is <50ms locally; 500ms = 10x headroom for
 * CI noise while staying unambiguously below any toxic latency we inject
 * (smoke uses 1500ms — 3x this ceiling). Callers must warm the connection
 * pool with one unmeasured request before asserting against this.
 */
export const FAST_PATH_CEILING_MS = 500;
