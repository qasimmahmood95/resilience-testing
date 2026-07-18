/**
 * RS-10 — at-least-once delivery vs exactly-once crediting
 *
 * Failure injected:   delivery-layer fault, not a network toxic: the same
 *                     `deposit.credited` webhook delivery is replayed N times
 *                     (`/simulator/webhooks/{id}/replay`), modelling
 *                     at-least-once delivery semantics after outages. The
 *                     replay path is the control plane BY DESIGN (F-01: no
 *                     injectable internal boundary), so no toxic applies.
 * Expected behaviour: every duplicate delivery is accepted without error.
 * Invariant:          **exactly-once crediting** — the wallet balance is
 *                     unchanged by every replay; duplicate deliveries feed an
 *                     idempotent credit handler, never a second credit.
 * Falsification:      FALSIFY=RS-10 registers N FRESH deposits (distinct
 *                     chainTxRefs — legitimately defeating the dedupe
 *                     surface) instead of replaying — the balance-unchanged
 *                     assertion fires, demonstrating what double-crediting
 *                     looks like.
 */
import { sabotaged } from './support/falsify.js';
import { provisionFundedClient } from './support/provision.js';
import { expect, test } from './fixtures/index.js';

const REPLAYS = 5;
const DEPOSIT_AMOUNT = '500.00';

interface DeliveryPage {
  items: { id: string; event: string; payload: string }[];
}

test.describe('RS-10 webhook replay crediting', () => {
  test('N duplicate deliveries of one credit event credit exactly once', async ({ control }) => {
    const fx = await provisionFundedClient(control);

    // Subscribe so deliveries are recorded (mock platform: recorded locally).
    const sub = await control.post('/webhooks/subscriptions', {
      body: {
        url: `http://sink.invalid/rs10-${fx.runId}`,
        secret: `rs10-secret-${fx.runId}`,
        events: ['deposit.credited'],
      },
    });
    expect(sub.status).toBe(201);

    // A second deposit on the provisioned wallet, settled via chain advance.
    const chainTxRef = `rs10-dep-${fx.runId}`;
    const dep = await control.post<{ id: string }>(`/wallets/${fx.walletId}/deposits/simulate`, {
      body: { amount: DEPOSIT_AMOUNT, chainTxRef },
    });
    expect(dep.status).toBe(201);
    expect((await control.post('/simulator/chain/advance', { body: { blocks: 2 } })).status).toBe(200);

    // Baseline AFTER the deposit settled: this number must never move again.
    const baseline = await control.get<{ balance: string }>(`/wallets/${fx.walletId}`);
    if (baseline.body === undefined) throw new Error('wallet read failed');
    const balanceAfterCredit = baseline.body.balance;

    // Find the recorded delivery for OUR deposit — matched by chainTxRef in
    // the payload, not by wallet: subscriptions persist across runs against
    // the same stack, so the wallet may have OTHER recorded deliveries (e.g.
    // the provisioning deposit's).
    const deliveries = await control.get<DeliveryPage>('/webhooks/deliveries?event=deposit.credited');
    const delivery = deliveries.body?.items.find((d) => d.payload.includes(chainTxRef));
    if (delivery === undefined) throw new Error('no recorded deposit.credited delivery for the fixture deposit');

    if (!sabotaged('RS-10')) {
      // The scenario: the SAME delivery arrives N more times. Each replay
      // must provably REACH the credit handler and be deduplicated there —
      // 'already-credited' is the idempotency surface answering; any other
      // reason means the replay short-circuited and this test proved nothing.
      for (let i = 0; i < REPLAYS; i += 1) {
        const replay = await control.post<{ creditResult?: { credited: boolean; reason: string } }>(
          `/simulator/webhooks/${delivery.id}/replay`,
        );
        expect(replay.status, `replay #${i + 1} accepted`).toBe(200);
        expect(replay.body?.creditResult?.credited, `replay #${i + 1} did not re-credit`).toBe(false);
        expect(replay.body?.creditResult?.reason, `replay #${i + 1} hit the dedupe surface`).toBe(
          'already-credited',
        );
      }
    } else {
      // Sabotage: N genuinely NEW deposits — the credit handler SHOULD credit
      // these, so the balance-unchanged assertion below must fail.
      for (let i = 0; i < REPLAYS; i += 1) {
        await control.post(`/wallets/${fx.walletId}/deposits/simulate`, {
          body: { amount: DEPOSIT_AMOUNT, chainTxRef: `${chainTxRef}-sab-${i}` },
        });
      }
      await control.post('/simulator/chain/advance', { body: { blocks: 2 } });
    }

    // Exactly-once: N duplicate deliveries moved the balance by exactly zero.
    const after = await control.get<{ balance: string }>(`/wallets/${fx.walletId}`);
    expect(after.body?.balance).toBe(balanceAfterCredit);

    // And the credit trail confirms a single settlement for this deposit.
    const audit = await control.get<{ items: { action: string }[] }>(
      `/audit?entityType=Transaction&entityId=${dep.body?.id ?? ''}&limit=100`,
    );
    const credits = audit.body?.items.filter((e) => e.action === 'TRANSACTION_CREDITED') ?? [];
    expect(credits).toHaveLength(1);
  });
});
