/**
 * RS-02 — black-holed client plane, then idempotent retry
 *
 * Failure injected:   timeout toxic (timeout: 0 — accept the connection,
 *                     deliver nothing, hold forever), upstream, client-plane.
 * Expected behaviour: the client aborts at ITS deadline (typed TimeoutError,
 *                     never an unbounded hang); the server never saw the
 *                     request; after recovery, the retry with the SAME
 *                     idempotency key succeeds.
 * Invariant:          bounded waiting + exactly-once creation: 0 transactions
 *                     while dark, exactly 1 after the retry.
 * Falsification:      FALSIFY=RS-02 skips the toxic — the "first attempt must
 *                     abort" assertion fails (the request just succeeds).
 */
import { BUDGET_FAST_MS } from './support/config.js';
import { sabotaged } from './support/falsify.js';
import { countByIdempotencyKey, provisionFundedClient, type Withdrawal } from './support/provision.js';
import { expect, test } from './fixtures/index.js';

/**
 * ABORT_BUDGET_MS: how long the client waits before giving up on a dark
 * plane. Must exceed any healthy round-trip (BUDGET_FAST_MS covers that with
 * 40x headroom over observed latency) yet keep the test fast. A healthy plane
 * can never trip this; only the black hole can.
 */
const ABORT_BUDGET_MS = 1_500;

test.describe('RS-02 black hole + idempotent retry', () => {
  test('client aborts at its deadline; retry with same key creates exactly one', async ({
    toxics,
    clientPlane,
    control,
  }) => {
    const fx = await provisionFundedClient(control);
    const idempotencyKey = `rs02-${fx.runId}`;
    const body = {
      walletId: fx.walletId,
      amount: '40.00',
      counterpartyAddress: fx.destAddress,
      idempotencyKey,
    };

    const toxic = sabotaged('RS-02')
      ? null
      : await toxics.apply({
          proxy: 'client-plane',
          type: 'timeout',
          stream: 'upstream',
          attributes: { timeout: 0 },
        });

    // Attempt 1: the plane is dark. The client must abort at its own budget —
    // a typed timeout, not a hang and not a mangled success.
    await expect(
      clientPlane.post('/withdrawals', { body, budgetMs: ABORT_BUDGET_MS }),
    ).rejects.toThrow(/timeout|abort/i);

    // Ground truth: the black-holed request never reached VaultChain.
    expect(await countByIdempotencyKey(control, fx.walletId, idempotencyKey)).toBe(0);

    // Network recovers.
    if (toxic !== null) await toxics.remove('client-plane', toxic.name);

    // Attempt 2: same idempotency key, after recovery. Removing a timeout
    // toxic severs the connections it held, so undici's keep-alive pool can
    // hand this request a dead socket ("other side closed") — an ambiguous
    // transport failure, the EXACT case idempotency keys exist for. A real
    // integrator retries transport errors; model that explicitly, bounded to
    // one extra attempt on a fresh socket.
    let retry: Awaited<ReturnType<typeof clientPlane.post<Withdrawal>>>;
    try {
      retry = await clientPlane.post<Withdrawal>('/withdrawals', { body });
    } catch (err) {
      console.log(`[RS-02] transport error on post-recovery retry (${String(err)}) — one fresh-socket retry`);
      retry = await clientPlane.post<Withdrawal>('/withdrawals', { body });
    }
    expect(retry.status).toBe(201);
    expect(retry.body?.idempotencyKey).toBe(idempotencyKey);
    expect(await countByIdempotencyKey(control, fx.walletId, idempotencyKey)).toBe(1);

    // And the key is a real dedupe handle, not decoration: an immediate
    // replay returns the SAME transaction, 200 not 201.
    const replay = await clientPlane.post<Withdrawal>('/withdrawals', { body });
    expect(replay.status).toBe(200);
    expect(replay.body?.id).toBe(retry.body?.id);
    expect(await countByIdempotencyKey(control, fx.walletId, idempotencyKey)).toBe(1);
  });
});
