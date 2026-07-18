/**
 * RS-03 - response torn after the server committed (the ambiguous outcome)
 *
 * Failure injected:   limit_data toxic (CUT_AFTER_BYTES), downstream,
 *                     client-plane: the request reaches VaultChain intact and
 *                     COMMITS; the response dies after a few bytes.
 * Expected behaviour: the client sees a transport error and cannot know the
 *                     outcome; ground truth shows the withdrawal exists.
 * Invariant:          **no double-settlement**: replaying with the SAME
 *                     idempotency key returns the ORIGINAL transaction
 *                     (200, same id); exactly one transaction exists at every
 *                     point.
 * Falsification:      FALSIFY=RS-03 retries with a DIFFERENT key - the
 *                     exactly-one assertion fires, demonstrating the
 *                     double-create this scenario exists to prevent
 *                     (see also finding F-06: the key is optional).
 */
import { sabotaged } from './support/falsify.js';
import { countByIdempotencyKey, provisionFundedClient, type Withdrawal } from './support/provision.js';
import { diedAtTransport, retryOnceOnTransportError } from './support/transport.js';
import { expect, test } from './fixtures/index.js';

/**
 * CUT_AFTER_BYTES: far below the ~500B response (headers alone exceed it), so
 * the client can never read a complete response while the toxic is live; far
 * above 0 so the request path is provably unaffected.
 */
const CUT_AFTER_BYTES = 64;

test.describe('RS-03 torn response + idempotent replay', () => {
  test('an ambiguous commit is resolved by the idempotency key, not by guessing', async ({
    toxics,
    clientPlane,
    control,
  }) => {
    const fx = await provisionFundedClient(control);
    const idempotencyKey = `rs03-${fx.runId}`;
    const body = {
      walletId: fx.walletId,
      amount: '75.00',
      counterpartyAddress: fx.destAddress,
      idempotencyKey,
    };

    // The toxic is ALWAYS applied in this scenario - sabotage attacks the
    // recovery protocol (wrong key), not the fault.
    const toxic = await toxics.apply({
      proxy: 'client-plane',
      type: 'limit_data',
      stream: 'downstream',
      attributes: { bytes: CUT_AFTER_BYTES },
    });

    // The attempt MUST die at the transport layer (torn response). If it
    // succeeds, the fault did not bite and this test has proven nothing.
    expect(await diedAtTransport(() => clientPlane.post('/withdrawals', { body }))).toBe(true);

    // Ground truth: the server COMMITTED despite the client-side error.
    // This is what makes the outcome ambiguous - and dangerous.
    expect(await countByIdempotencyKey(control, fx.walletId, idempotencyKey)).toBe(1);
    const truth = await control.get<{ items: Withdrawal[] }>(
      `/withdrawals?walletId=${fx.walletId}&limit=100`,
    );
    const original = truth.body?.items.find((w) => w.idempotencyKey === idempotencyKey);
    if (original === undefined) throw new Error('committed withdrawal not found via control plane');

    await toxics.remove('client-plane', toxic.name);

    // Recovery: the integrator replays. Same key = safe; a different key
    // (sabotage) double-creates.
    const replayKey = sabotaged('RS-03') ? `rs03-sab-${fx.runId}` : idempotencyKey;
    const replay = await retryOnceOnTransportError('RS-03', () =>
      clientPlane.post<Withdrawal>('/withdrawals', { body: { ...body, idempotencyKey: replayKey } }),
    );

    // Exactly one transaction for this wallet - the invariant this scenario
    // exists for. (Under sabotage the second create makes this 2.)
    const wallet = await control.get<{ items: Withdrawal[] }>(
      `/withdrawals?walletId=${fx.walletId}&limit=100`,
    );
    expect(wallet.body?.items).toHaveLength(1);

    // And the replay resolved the ambiguity to the ORIGINAL transaction:
    // 200 (not a fresh 201), same id.
    expect(replay.status).toBe(200);
    expect(replay.body?.id).toBe(original.id);
  });
});
