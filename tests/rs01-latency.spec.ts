/**
 * RS-01 - high latency on the client plane
 *
 * Failure injected:   latency 2000ms (jitter 0 - determinism policy; the
 *                     scenario table's +/-500ms jitter is deliberately dropped:
 *                     unseedable randomness buys no extra coverage here),
 *                     downstream, client-plane.
 * Expected behaviour: the withdrawal completes slowly but correctly within an
 *                     explicit raised budget; the response is intact.
 * Invariant:          degradation is SLOW, not WRONG - exactly one transaction
 *                     is created, response fields are exact, and ground truth
 *                     (control plane) agrees with the degraded response.
 * Falsification:      FALSIFY=RS-01 skips the toxic - the elapsed-time floor
 *                     assertion must fail (a fast pass proves the test cannot
 *                     detect a missing fault).
 */
import { BUDGET_FAST_MS } from './support/config.js';
import { sabotaged } from './support/falsify.js';
import { countByIdempotencyKey, provisionFundedClient, type Withdrawal } from './support/provision.js';
import { expect, test } from './fixtures/index.js';

/** Toxic latency: unambiguously above CI noise, below suite-hostile. */
const LATENCY_MS = 2_000;
/** Client budget under degradation: toxic latency + healthy-path budget. */
const DEGRADED_BUDGET_MS = LATENCY_MS + BUDGET_FAST_MS;

test.describe('RS-01 latency', () => {
  test('a slow plane yields a slow, correct withdrawal - not a wrong one', async ({
    toxics,
    clientPlane,
    control,
  }) => {
    const fx = await provisionFundedClient(control);
    const idempotencyKey = `rs01-${fx.runId}`;

    if (!sabotaged('RS-01')) {
      await toxics.apply({
        proxy: 'client-plane',
        type: 'latency',
        stream: 'downstream',
        attributes: { latency: LATENCY_MS, jitter: 0 },
      });
    }

    const t0 = performance.now();
    const res = await clientPlane.post<Withdrawal>('/withdrawals', {
      body: {
        walletId: fx.walletId,
        amount: '25.00',
        counterpartyAddress: fx.destAddress,
        idempotencyKey,
      },
      budgetMs: DEGRADED_BUDGET_MS,
    });
    const elapsed = performance.now() - t0;

    // The toxic actually bit: the round-trip paid at least the injected latency.
    expect(elapsed).toBeGreaterThanOrEqual(LATENCY_MS);

    // Slow, not wrong: full, exact response despite degradation.
    expect(res.status).toBe(201);
    expect(res.body?.state).toBe('PENDING_APPROVAL');
    expect(res.body?.amount).toBe('25.00');
    expect(res.body?.idempotencyKey).toBe(idempotencyKey);
    expect(res.body?.walletId).toBe(fx.walletId);

    // Ground truth via the clean plane agrees: exactly one transaction.
    expect(await countByIdempotencyKey(control, fx.walletId, idempotencyKey)).toBe(1);
  });
});
