/**
 * RS-04 — dual approval under an ambiguous first approval
 *
 * Failure injected:   limit_data toxic (64 bytes), downstream, ops-plane:
 *                     operator A's approval COMMITS server-side but the
 *                     response is torn.
 * Expected behaviour: A cannot know the outcome; A's retry is answered by a
 *                     typed 409 `already-decided` (the unique
 *                     approver-per-transaction constraint), never a second
 *                     effect. B's approval completes the dual control; B's
 *                     post-completion retry is a typed 409 as well.
 * Invariant:          maker-checker survives ambiguity: exactly 2 audited
 *                     approvals by distinct approvers, exactly one debit of
 *                     amount + fee, and every retry answered with problem+json
 *                     conflicts — never double-counted, never hung.
 * Falsification:      FALSIFY=RS-04 skips the toxic — the
 *                     first-approval-must-die-at-transport assertion fires.
 */
import { API_KEYS } from './support/config.js';
import { sabotaged } from './support/falsify.js';
import { provisionFundedClient, type Withdrawal } from './support/provision.js';
import { diedAtTransport, retryOnceOnTransportError } from './support/transport.js';
import type { Problem } from './support/vaultchain.js';
import { expect, test } from './fixtures/index.js';

const CUT_AFTER_BYTES = 64;
/** 1500.00 GBPX ≥ the 1000.00 dual-approval threshold → 2 distinct approvers. */
const AMOUNT = '1500.00';
/** Flat 10 bps fee → 1.50 on 1500.00. */
const FEE = '1.50';
/** Provisioned deposit; final balance must be exactly DEPOSIT − AMOUNT − FEE. */
const DEPOSIT = '100000.00';
const FINAL_BALANCE = '98498.50';

interface AuditPage {
  items: { action: string }[];
  nextCursor: string | null;
}

test.describe('RS-04 dual approval under ambiguity', () => {
  test('ambiguous approvals never double-count; dual control completes exactly once', async ({
    toxics,
    clientPlane,
    opsPlane,
    control,
  }) => {
    const fx = await provisionFundedClient(control, { depositAmount: DEPOSIT });

    // Maker: CLIENT #1 creates the withdrawal (so both operators are eligible
    // checkers; maker-cannot-check applies to the creator key only).
    const created = await clientPlane.post<Withdrawal>('/withdrawals', {
      body: {
        walletId: fx.walletId,
        amount: AMOUNT,
        counterpartyAddress: fx.destAddress,
        idempotencyKey: `rs04-${fx.runId}`,
      },
    });
    expect(created.status).toBe(201);
    const txId = created.body?.id;
    if (txId === undefined) throw new Error('withdrawal creation returned no id');

    const approvalCount = async (): Promise<number> => {
      const audit = await control.get<AuditPage>(
        `/audit?entityType=Transaction&entityId=${txId}&limit=100`,
      );
      if (audit.status !== 200 || audit.body === undefined) {
        throw new Error(`audit read failed (${audit.status})`);
      }
      return audit.body.items.filter((e) => e.action === 'WITHDRAWAL_APPROVAL_RECORDED').length;
    };

    const toxic = sabotaged('RS-04')
      ? null
      : await toxics.apply({
          proxy: 'ops-plane',
          type: 'limit_data',
          stream: 'downstream',
          attributes: { bytes: CUT_AFTER_BYTES },
        });

    // Operator A approves; the response is torn AFTER the server committed.
    expect(
      await diedAtTransport(() =>
        opsPlane.post(`/withdrawals/${txId}/approvals`, {
          body: { decision: 'APPROVE' },
          apiKey: API_KEYS.operatorA,
        }),
      ),
    ).toBe(true);

    // Ground truth: the approval landed; dual control still pending.
    expect(await approvalCount()).toBe(1);
    const mid = await control.get<Withdrawal>(`/withdrawals/${txId}`);
    expect(mid.body?.state).toBe('PENDING_APPROVAL');

    if (toxic !== null) await toxics.remove('ops-plane', toxic.name);

    // A's retry: answered by the unique-approver constraint — a typed 409,
    // not a second approval, not a hang.
    const aRetry = await retryOnceOnTransportError('RS-04:retryA', () =>
      opsPlane.post<Problem>(`/withdrawals/${txId}/approvals`, {
        body: { decision: 'APPROVE' },
        apiKey: API_KEYS.operatorA,
      }),
    );
    expect(aRetry.status).toBe(409);
    expect(aRetry.contentType).toContain('application/problem+json');
    expect(aRetry.body?.type).toContain('already-decided');
    expect(await approvalCount()).toBe(1);

    // Operator B completes dual control; the lifecycle advances through
    // screening (CLEAN) and broadcast in one server-side progression.
    const bApproval = await opsPlane.post<Withdrawal>(`/withdrawals/${txId}/approvals`, {
      body: { decision: 'APPROVE' },
      apiKey: API_KEYS.operatorB,
    });
    expect(bApproval.status).toBe(201);
    expect(bApproval.body?.state).toBe('PENDING_CONFIRMATION');

    // B's late retry: approvals are closed — typed 409 again.
    const bRetry = await opsPlane.post<Problem>(`/withdrawals/${txId}/approvals`, {
      body: { decision: 'APPROVE' },
      apiKey: API_KEYS.operatorB,
    });
    expect(bRetry.status).toBe(409);
    expect(bRetry.contentType).toContain('application/problem+json');
    expect(bRetry.body?.type).toContain('not-pending-approval');

    // Final ground truth: exactly 2 audited approvals, exactly one debit.
    expect(await approvalCount()).toBe(2);
    const wallet = await control.get<{ balance: string }>(`/wallets/${fx.walletId}`);
    expect(wallet.body?.balance).toBe(FINAL_BALANCE);
  });
});
