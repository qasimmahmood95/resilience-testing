/**
 * RS-00 (scaffolding smoke - precondition for every other scenario)
 *
 * Failure injected:   latency 1500ms on client-plane only (then removed).
 * Expected behaviour: degraded plane slows by >= the toxic latency; control
 *                     plane stays fast and truthful throughout.
 * Invariant:          the harness itself is sound - all planes reach the same
 *                     seeded VaultChain; toxics apply and remove cleanly; the
 *                     control plane is provably unaffected by client-plane
 *                     toxics (observation integrity, ADR-0002).
 * Falsification:      plant a toxic via the raw Toxiproxy API (bypassing the
 *                     fixture) - leak detection must fail the next test; or
 *                     assert fast-path timing with the toxic still applied -
 *                     the FAST_PATH_CEILING_MS assertions must fail.
 *                     (Verified manually for M1; harness automates this in M2.)
 */
import { API_KEYS, BUDGET_FAST_MS, FAST_PATH_CEILING_MS } from './support/config.js';
import { expect, test } from './fixtures/index.js';

/**
 * SMOKE_LATENCY_MS: large enough that a toxified round-trip is unambiguously
 * distinguishable from CI noise (healthy < FAST_PATH_CEILING_MS asserted
 * below, 3x margin), small enough to keep the suite quick. No jitter -
 * deterministic.
 */
const SMOKE_LATENCY_MS = 1_500;

/**
 * DARK_PROBE_BUDGET_MS: budget for proving a black-holed plane is actually
 * dark. Must exceed FAST_PATH_CEILING_MS (so a healthy plane could never
 * trip it) and stay far below the 60s test ceiling.
 */
const DARK_PROBE_BUDGET_MS = 1_500;

test.describe('RS-00 stack smoke', () => {
  test('all three planes reach the same healthy VaultChain', async ({ clientPlane, opsPlane, control }) => {
    for (const vc of [clientPlane, opsPlane, control]) {
      const res = await vc.get<{ status: string }>('/health');
      expect(res.status, `plane=${vc.plane}`).toBe(200);
      expect(res.body?.status, `plane=${vc.plane}`).toBe('ok');
    }
  });

  test('seeded state is reachable and role-scoped per plane', async ({ clientPlane, opsPlane, control }) => {
    const me = await control.get<{ role: string }>('/me');
    expect(me.status).toBe(200);
    expect(me.body?.role).toBe('ADMIN');

    const client = await clientPlane.get<{ role: string; clientId: string | null }>('/me');
    expect(client.status).toBe(200);
    expect(client.body?.role).toBe('CLIENT');
    expect(client.body?.clientId).not.toBeNull();

    const ops = await opsPlane.get<{ role: string }>('/me');
    expect(ops.status).toBe(200);
    expect(ops.body?.role).toBe('OPERATOR');

    // Typed-error contract holds on the happy stack: bad key -> problem+json.
    const bad = await control.get('/me', { apiKey: 'vck_not_a_real_key_000000' });
    expect(bad.status).toBe(401);
    expect(bad.contentType).toContain('application/problem+json');
  });

  test('a client-plane toxic degrades only the client plane, and removal restores it', async ({
    toxics,
    clientPlane,
    control,
  }) => {
    // Warm the connection pool off the clock, then take a healthy baseline.
    await clientPlane.get('/health');
    await control.get('/health');
    const t0 = performance.now();
    expect((await clientPlane.get('/health')).status).toBe(200);
    const healthyMs = performance.now() - t0;
    expect(healthyMs).toBeLessThan(FAST_PATH_CEILING_MS);

    const toxic = await toxics.apply({
      proxy: 'client-plane',
      type: 'latency',
      stream: 'downstream',
      attributes: { latency: SMOKE_LATENCY_MS, jitter: 0 },
    });

    // Degraded: client plane pays the toxic latency (budget raised accordingly:
    // toxic + healthy budget)...
    const t1 = performance.now();
    const degraded = await clientPlane.get('/health', { budgetMs: SMOKE_LATENCY_MS + BUDGET_FAST_MS });
    expect(degraded.status).toBe(200);
    expect(performance.now() - t1).toBeGreaterThanOrEqual(SMOKE_LATENCY_MS);

    // ...while the control plane - same upstream, different proxy - is untouched.
    const t2 = performance.now();
    expect((await control.get('/health')).status).toBe(200);
    expect(performance.now() - t2).toBeLessThan(FAST_PATH_CEILING_MS);

    // Recovery: removing the toxic restores the fast path.
    await toxics.remove('client-plane', toxic.name);
    const t3 = performance.now();
    expect((await clientPlane.get('/health')).status).toBe(200);
    expect(performance.now() - t3).toBeLessThan(FAST_PATH_CEILING_MS);
  });

  test('control plane drives the simulator while client plane is dark', async ({
    toxics,
    clientPlane,
    control,
    cleanSimState,
  }) => {
    void cleanSimState; // canonical chain/clock state before mutating it below
    // Black-hole the client plane entirely; the observation/control plane must
    // still exercise ground-truth reads AND simulator writes.
    await toxics.apply({
      proxy: 'client-plane',
      type: 'timeout',
      stream: 'upstream',
      attributes: { timeout: 0 }, // 0 = never respond, hold the connection
    });

    // Prove the plane is actually dark, or this test is vacuous: a budgeted
    // probe must abort. (A healthy plane answers in < FAST_PATH_CEILING_MS,
    // 3x under this budget - the abort can only come from the toxic.)
    await expect(clientPlane.get('/health', { budgetMs: DARK_PROBE_BUDGET_MS })).rejects.toThrow(
      /timeout|abort/i,
    );

    const state = await control.get<{ blockHeight: number }>('/simulator/state');
    expect(state.status).toBe(200);
    const before = state.body?.blockHeight;
    if (typeof before !== 'number') {
      throw new Error(`/simulator/state returned no numeric blockHeight: ${JSON.stringify(state.body)}`);
    }

    const advance = await control.post<{ blockHeight: number }>('/simulator/chain/advance', {
      body: { blocks: 1 },
    });
    expect(advance.status).toBe(200);
    expect(advance.body?.blockHeight).toBe(before + 1);
  });

  test('auth is enforced identically through a proxy plane', async ({ clientPlane }) => {
    // A CLIENT key must not reach the admin-only simulator surface through any
    // plane (requireRole('ADMIN') on /simulator/* - VaultChain src/routes/simulator.ts).
    const res = await clientPlane.get('/simulator/state', { apiKey: API_KEYS.client01 });
    expect(res.status).toBe(403);
    expect(res.contentType).toContain('application/problem+json');
  });
});
