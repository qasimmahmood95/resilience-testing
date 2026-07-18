/**
 * RS-06 — compliance hold release with a torn response
 *
 * Failure injected:   limit_data toxic (64 bytes), DOWNSTREAM, ops-plane:
 *                     the officer's release COMMITS server-side (hold
 *                     resolved, withdrawal broadcast, balance debited) but
 *                     the response is torn.
 * Expected behaviour: the officer cannot know the outcome; the retry is
 *                     answered by a typed 409 `hold-not-open` — never a
 *                     second release, never a second debit.
 * Invariant:          hold resolution is EXACTLY-ONCE under ambiguity: hold
 *                     is RELEASED, exactly one HOLD_RELEASED audit row,
 *                     exactly one debit, and the retry is a typed conflict —
 *                     never a second effect. (Deliberately NOT claimed:
 *                     atomicity of the compound release→broadcast operation —
 *                     VaultChain runs those as separate DB transactions; see
 *                     finding F-08.)
 * Falsification:      FALSIFY=RS-06 skips the cut — the release-must-die-at-
 *                     transport assertion fires (it just succeeds).
 */
import { API_KEYS } from './support/config.js';
import { sabotaged } from './support/falsify.js';
import { provisionFundedClient, type Withdrawal } from './support/provision.js';
import { diedAtTransport, retryOnceOnTransportError } from './support/transport.js';
import type { Problem } from './support/vaultchain.js';
import { expect, test } from './fixtures/index.js';

/**
 * CUT_AFTER_BYTES: 64 is smaller than any complete HTTP status-line + headers
 * block, so no complete response can ever cross the cut — the commit is
 * DETERMINISTICALLY invisible to the officer, never "sometimes readable".
 */
const CUT_AFTER_BYTES = 64;
/** Below the 1000.00 dual-approval threshold → a single approval suffices. */
const AMOUNT = '500.00';
const DEPOSIT = '100000.00';
/** 10 bps fee on 500.00 = 0.50; debit happens at (post-release) broadcast. */
const BALANCE_SETTLED = '99499.50';

interface Hold {
  id: string;
  state: string;
  transactionId: string;
}

test.describe('RS-06 hold release under ambiguity', () => {
  test('a torn release resolves exactly once; the retry is a typed conflict', async ({
    toxics,
    clientPlane,
    opsPlane,
    control,
    cleanSimState,
  }) => {
    // cleanSimState clears the GLOBAL one-shot screeningNext slot: a FLAG
    // leaked by an earlier failed test would otherwise be consumed by our
    // provisioning deposit and hold IT instead (cross-test poisoning).
    void cleanSimState;
    const fx = await provisionFundedClient(control, { depositAmount: DEPOSIT });

    // Queue exactly one FLAG so screening opens a hold for OUR withdrawal.
    expect(
      (await control.post('/simulator/screening/next', { body: { outcome: 'FLAG' } })).status,
    ).toBe(200);

    const created = await clientPlane.post<Withdrawal>('/withdrawals', {
      body: {
        walletId: fx.walletId,
        amount: AMOUNT,
        counterpartyAddress: fx.destAddress,
        idempotencyKey: `rs06-${fx.runId}`,
      },
    });
    expect(created.status).toBe(201);
    const txId = created.body?.id;
    if (txId === undefined) throw new Error('creation returned no id');

    const approval = await opsPlane.post<Withdrawal>(`/withdrawals/${txId}/approvals`, {
      body: { decision: 'APPROVE' },
      apiKey: API_KEYS.operatorA,
    });
    expect(approval.status).toBe(201);
    expect(approval.body?.state).toBe('HELD');

    // Locate the OPEN hold for our transaction (ground truth, clean plane).
    const holds = await control.get<{ items: Hold[] }>('/holds?state=OPEN&limit=100');
    const hold = holds.body?.items.find((h) => h.transactionId === txId);
    if (hold === undefined) throw new Error('no OPEN hold found for the flagged withdrawal');

    const releasedAuditCount = async (): Promise<number> => {
      const audit = await control.get<{ items: { action: string }[] }>(
        `/audit?entityType=ComplianceHold&entityId=${hold.id}&limit=100`,
      );
      return (audit.body?.items ?? []).filter((e) => e.action === 'HOLD_RELEASED').length;
    };

    const toxic = sabotaged('RS-06')
      ? null
      : await toxics.apply({
          proxy: 'ops-plane',
          type: 'limit_data',
          stream: 'downstream',
          attributes: { bytes: CUT_AFTER_BYTES },
        });

    // The officer releases; the response is torn AFTER the commit.
    expect(
      await diedAtTransport(() =>
        opsPlane.post(`/holds/${hold.id}/release`, { apiKey: API_KEYS.compliance }),
      ),
    ).toBe(true);

    // Ground truth: the release happened — atomically and completely.
    // Hold RELEASED, withdrawal broadcast+debited, exactly one audit row.
    expect((await control.get<Hold>(`/holds/${hold.id}`)).body?.state).toBe('RELEASED');
    expect((await control.get<Withdrawal>(`/withdrawals/${txId}`)).body?.state).toBe('PENDING_CONFIRMATION');
    expect(await releasedAuditCount()).toBe(1);

    if (toxic !== null) await toxics.remove('ops-plane', toxic.name);

    // The officer's retry: a typed 409 `hold-not-open` — the ambiguity is
    // resolved by the API's answer, not by a second effect.
    const retry = await retryOnceOnTransportError('RS-06', () =>
      opsPlane.post<Problem>(`/holds/${hold.id}/release`, { apiKey: API_KEYS.compliance }),
    );
    expect(retry.status).toBe(409);
    expect(retry.contentType).toContain('application/problem+json');
    expect(retry.body?.type).toContain('hold-not-open');
    expect(await releasedAuditCount()).toBe(1);

    // Exactly one debit, to the penny.
    expect((await control.get<{ balance: string }>(`/wallets/${fx.walletId}`)).body?.balance).toBe(
      BALANCE_SETTLED,
    );
  });
});
