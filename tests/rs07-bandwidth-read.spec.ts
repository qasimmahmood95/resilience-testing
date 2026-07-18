/**
 * RS-07 — bandwidth-starved reads and resumable pagination
 *
 * Failure injected:   bandwidth toxic (RATE_KBPS), downstream, client-plane.
 * Expected behaviour: a large read completes slowly-but-intact within a
 *                     budget derived from measured payload size; an
 *                     under-budgeted read aborts cleanly (typed timeout).
 * Invariant:          throttling never corrupts data — the degraded payload
 *                     is identical in content to the clean-plane read, and
 *                     post-recovery pagination is complete and duplicate-free.
 * Falsification:      FALSIFY=RS-07 skips the toxic — the transfer-time floor
 *                     assertion must fail (the read is too fast).
 */
import { BUDGET_FAST_MS } from './support/config.js';
import { sabotaged } from './support/falsify.js';
import { provisionFundedClient, type Withdrawal } from './support/provision.js';
import type { VcResponse } from './support/vaultchain.js';
import { expect, test } from './fixtures/index.js';

/** Throttle rate. 16 KB/s makes a ~30+KB page take seconds — measurable, not glacial. */
const RATE_KBPS = 16;
/**
 * How many withdrawals to provision: >100 (one full page + remainder) so
 * pagination has a second page, and enough bytes that transfer time at
 * RATE_KBPS dominates CI noise (~120 rows ≈ 30-45 KB ≈ 2-3s at 16 KB/s).
 */
const SEED_WITHDRAWALS = 120;
const PAGE_LIMIT = 100;

interface Page {
  items: Withdrawal[];
  nextCursor: string | null;
}

test.describe('RS-07 bandwidth-starved reads', () => {
  // Provisioning 120 withdrawals through the API takes a while on its own.
  test.setTimeout(120_000);

  test('throttled reads are slow but intact; pagination resumes complete and duplicate-free', async ({
    toxics,
    clientPlane,
    control,
  }) => {
    const fx = await provisionFundedClient(control);
    for (let i = 0; i < SEED_WITHDRAWALS; i += 1) {
      const res = await control.post('/withdrawals', {
        body: {
          walletId: fx.walletId,
          amount: '2.00',
          counterpartyAddress: fx.destAddress,
          idempotencyKey: `rs07-${fx.runId}-${String(i).padStart(3, '0')}`,
        },
      });
      if (res.status !== 201) throw new Error(`seed withdrawal ${i} failed (${res.status})`);
    }

    const path = `/withdrawals?walletId=${fx.walletId}&limit=${PAGE_LIMIT}`;

    // Measure ground truth on the clean plane: content AND byte size.
    const clean = await control.get<Page>(path);
    expect(clean.status).toBe(200);
    if (clean.body === undefined) throw new Error('truth read had no body');
    // Transfer-time floor: payload bytes at RATE_KBPS, with 25% slack for
    // toxiproxy's chunked pacing. Only the toxic can make the read this slow.
    const minTransferMs = (clean.bytes / (RATE_KBPS * 1024)) * 1000 * 0.75;
    expect(minTransferMs).toBeGreaterThan(BUDGET_FAST_MS / 2); // payload big enough to measure

    const toxic = sabotaged('RS-07')
      ? null
      : await toxics.apply({
          proxy: 'client-plane',
          type: 'bandwidth',
          stream: 'downstream',
          attributes: { rate: RATE_KBPS },
        });

    // Under-budgeted read: aborts cleanly at the client's deadline, no hang.
    await expect(
      clientPlane.get(path, { budgetMs: Math.round(minTransferMs / 3) }),
    ).rejects.toThrow(/timeout|abort/i);

    // Adequately-budgeted read: slow but INTACT — identical ids in identical order.
    const t0 = performance.now();
    const throttled = await clientPlane.get<Page>(path, {
      budgetMs: Math.round(minTransferMs * 3) + BUDGET_FAST_MS,
    });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(minTransferMs);
    expect(throttled.status).toBe(200);
    expect(throttled.body?.items.map((w) => w.id)).toEqual(clean.body.items.map((w) => w.id));
    expect(throttled.bytes).toBe(clean.bytes);

    // Recovery: full pagination on the client plane — complete, no duplicates.
    if (toxic !== null) await toxics.remove('client-plane', toxic.name);
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: VcResponse<Page> = await clientPlane.get<Page>(
        cursor === null ? path : `${path}&cursor=${cursor}`,
      );
      expect(page.status).toBe(200);
      if (page.body === undefined) throw new Error('pagination page had no body');
      for (const w of page.body.items) {
        expect(seen.has(w.id), `duplicate id ${w.id} across pages`).toBe(false);
        seen.add(w.id);
      }
      cursor = page.body.nextCursor;
    } while (cursor !== null);
    expect(seen.size).toBe(SEED_WITHDRAWALS);
  });
});
