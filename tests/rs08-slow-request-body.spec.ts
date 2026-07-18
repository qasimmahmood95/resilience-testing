/**
 * RS-08 — slow-loris-shaped request body (trickled upload)
 *
 * Failure injected:   bandwidth toxic 1 KB/s, upstream, client-plane; the
 *                     client sends a ~6 KB JSON body, so the server receives
 *                     it over ~6 seconds.
 * Expected behaviour: VaultChain accepts the trickle and still answers with a
 *                     typed problem+json (the body carries an unknown field,
 *                     so 400) — degraded ingress never produces a hang for
 *                     OTHER callers or an untyped error for this one.
 * Invariant:          (a) isolation — the ops plane stays fast while the
 *                     trickle is in flight; (b) typed errors survive
 *                     degradation. Server-side ingress boundedness itself is
 *                     NOT asserted: VaultChain configures no request timeout —
 *                     recorded as a finding (docs/FINDINGS.md), with the
 *                     trickle tolerance below as its empirical evidence.
 * Falsification:      FALSIFY=RS-08 skips the toxic — the upload-duration
 *                     floor assertion must fail (the body arrives instantly).
 */
import { BUDGET_FAST_MS, FAST_PATH_CEILING_MS } from './support/config.js';
import { sabotaged } from './support/falsify.js';
import { provisionFundedClient } from './support/provision.js';
import { expect, test } from './fixtures/index.js';

/** Upstream trickle rate. */
const RATE_KBPS = 1;
/** Padding bytes: ~6 KB at 1 KB/s ≈ 6s of upload — long enough to probe under, short enough for CI. */
const PADDING_BYTES = 6_000;
/** Floor for the degraded upload, with 25% slack for toxiproxy chunk pacing. */
const MIN_UPLOAD_MS = (PADDING_BYTES / (RATE_KBPS * 1024)) * 1000 * 0.75;

test.describe('RS-08 slow request body', () => {
  test('a trickled upload stays typed and never starves the ops plane', async ({
    toxics,
    clientPlane,
    opsPlane,
    control,
  }) => {
    const fx = await provisionFundedClient(control);

    if (!sabotaged('RS-08')) {
      await toxics.apply({
        proxy: 'client-plane',
        type: 'bandwidth',
        stream: 'upstream',
        attributes: { rate: RATE_KBPS },
      });
    }

    // An invalid `amount` (pattern violation) forces a 400 that the server
    // can only produce after receiving the whole trickled body. NOTE: an
    // *unknown* field would NOT work here — VaultChain's Fastify/AJV config
    // silently STRIPS unknown fields rather than rejecting them despite
    // `additionalProperties: false` (observed: 201 with a `padding` field).
    // That is itself a finding (docs/FINDINGS.md F-04): a misspelled
    // `idempotencyKey` is dropped silently, making a retry non-idempotent.
    // The padding still travels the wire, so it still exercises the toxic.
    const t0 = performance.now();
    const slow = clientPlane.post('/withdrawals', {
      body: {
        walletId: fx.walletId,
        amount: 'not-a-decimal',
        counterpartyAddress: fx.destAddress,
        idempotencyKey: `rs08-${fx.runId}`,
        padding: 'x'.repeat(PADDING_BYTES),
      },
      budgetMs: Math.round(MIN_UPLOAD_MS * 3) + BUDGET_FAST_MS,
    });

    // While the trickle is in flight (it holds the wire for ≥ MIN_UPLOAD_MS,
    // and these three probes complete well inside that window), the ops plane
    // must be entirely unaffected — no head-of-line blocking across planes.
    for (let probe = 0; probe < 3; probe += 1) {
      const p0 = performance.now();
      const ops = await opsPlane.get('/health');
      expect(ops.status).toBe(200);
      expect(performance.now() - p0).toBeLessThan(FAST_PATH_CEILING_MS);
    }

    const res = await slow;
    const elapsed = performance.now() - t0;

    // The toxic actually bit: the upload took at least the trickle time.
    expect(elapsed).toBeGreaterThanOrEqual(MIN_UPLOAD_MS);

    // Typed even under degradation: problem+json 400 for the unknown field —
    // never a hang, a reset, or a bare 500.
    expect(res.status).toBe(400);
    expect(res.contentType).toContain('application/problem+json');

    // And the malformed attempt left no transaction behind (fail closed).
    const list = await control.get<{ items: { idempotencyKey: string | null }[] }>(
      `/withdrawals?walletId=${fx.walletId}&limit=100`,
    );
    expect(list.body?.items.filter((w) => w.idempotencyKey === `rs08-${fx.runId}`)).toEqual([]);
  });
});
