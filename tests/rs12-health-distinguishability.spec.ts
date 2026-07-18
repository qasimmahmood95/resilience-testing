/**
 * RS-12 — degraded edge vs degraded service
 *
 * Failure injected:   timeout toxic (hold forever), upstream, client-plane.
 * Expected behaviour: liveness probes through the degraded edge fail fast at
 *                     the prober's budget; the same probe through a healthy
 *                     path answers 200 immediately — CONCURRENTLY.
 * Invariant:          the health signal is trustworthy: an operator can
 *                     distinguish "the edge to clients is dead" from "the
 *                     service is dead", because observation through a healthy
 *                     path stays intact while the degraded path times out.
 * Falsification:      FALSIFY=RS-12 skips the toxic — the degraded-probe
 *                     abort assertion must fail (the probe just succeeds).
 */
import { FAST_PATH_CEILING_MS } from './support/config.js';
import { sabotaged } from './support/falsify.js';
import { expect, test } from './fixtures/index.js';

/** Prober patience for the dark edge; see RS-02's ABORT_BUDGET_MS derivation. */
const PROBE_BUDGET_MS = 1_500;

test.describe('RS-12 health distinguishability', () => {
  test('a dark edge and a live service are distinguishable at the same instant', async ({
    toxics,
    clientPlane,
    control,
  }) => {
    if (!sabotaged('RS-12')) {
      await toxics.apply({
        proxy: 'client-plane',
        type: 'timeout',
        stream: 'upstream',
        attributes: { timeout: 0 },
      });
    }

    // Same instant, both paths: the degraded edge must abort at the prober's
    // budget while the healthy path answers fast. Sequencing them would prove
    // less — the point is that the service is demonstrably up WHILE the
    // client edge is demonstrably dark.
    const darkProbe = expect(
      clientPlane.get('/health', { budgetMs: PROBE_BUDGET_MS }),
    ).rejects.toThrow(/timeout|abort/i);

    const t0 = performance.now();
    const live = await control.get<{ status: string }>('/health');
    const liveMs = performance.now() - t0;

    expect(live.status).toBe(200);
    expect(live.body?.status).toBe('ok');
    expect(liveMs).toBeLessThan(FAST_PATH_CEILING_MS);

    await darkProbe;
  });
});
