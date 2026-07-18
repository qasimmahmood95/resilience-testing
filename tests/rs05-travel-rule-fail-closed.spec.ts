/**
 * RS-05 — Travel-Rule attach torn mid-request: the gate must stay closed
 *
 * Failure injected:   limit_data toxic (64 bytes), UPSTREAM, ops-plane: the
 *                     officer's attach request dies before the body arrives.
 * Expected behaviour: the attach fails at the transport layer; VaultChain
 *                     never sees a complete request.
 * Invariant:          **fail closed** — the withdrawal cannot leave
 *                     TRAVEL_RULE_CHECK: state unchanged, zero gate-opening
 *                     transitions audited, balance untouched, and no partial
 *                     Travel-Rule record (proven by the recovery attach
 *                     succeeding as a FIRST attach, 201 — a partial record
 *                     would collide with the per-direction unique constraint).
 * Falsification:      FALSIFY=RS-05 skips the cut — the attach succeeds and
 *                     the must-die-at-transport assertion fires.
 */
import { API_KEYS } from './support/config.js';
import { sabotaged } from './support/falsify.js';
import { provisionFundedClient, type Withdrawal } from './support/provision.js';
import { diedAtTransport, retryOnceOnTransportError } from './support/transport.js';
import { expect, test } from './fixtures/index.js';

const CUT_AFTER_BYTES = 64;
const AMOUNT = '1500.00';
const DEPOSIT = '100000.00';
/** Untouched while the gate holds; DEPOSIT − 1500.00 − 1.50 after it opens. */
const BALANCE_GATED = '100000.00';
const BALANCE_SETTLED = '98498.50';

const TRAVEL_RULE_BODY = (runId: string) => ({
  originator: {
    name: 'RS-05 Originator',
    accountRef: `acct-${runId}`,
    physicalAddress: '5 Fail Closed Road, Test City',
  },
  beneficiary: { name: 'RS-05 Beneficiary', accountRef: `bene-${runId}` },
});

interface AuditPage {
  items: { action: string }[];
}

test.describe('RS-05 Travel-Rule gate fail-closed', () => {
  test('a torn attach leaves the gate closed; recovery attaches cleanly once', async ({
    toxics,
    clientPlane,
    opsPlane,
    control,
  }) => {
    const fx = await provisionFundedClient(control, { depositAmount: DEPOSIT });

    // Arm the gate: cross-VASP + >= 1000.00 fiat, dual-approved.
    const created = await clientPlane.post<Withdrawal>('/withdrawals', {
      body: {
        walletId: fx.walletId,
        amount: AMOUNT,
        counterpartyAddress: fx.destAddress,
        counterpartyVaspId: `VASP-EXT-${fx.runId}`,
        idempotencyKey: `rs05-${fx.runId}`,
      },
    });
    expect(created.status).toBe(201);
    const txId = created.body?.id;
    if (txId === undefined) throw new Error('creation returned no id');
    for (const operator of [API_KEYS.operatorA, API_KEYS.operatorB]) {
      const approval = await opsPlane.post<Withdrawal>(`/withdrawals/${txId}/approvals`, {
        body: { decision: 'APPROVE' },
        apiKey: operator,
      });
      expect(approval.status).toBe(201);
    }
    expect((await control.get<Withdrawal>(`/withdrawals/${txId}`)).body?.state).toBe('TRAVEL_RULE_CHECK');

    const gateTransitions = async (): Promise<string[]> => {
      const audit = await control.get<AuditPage>(
        `/audit?entityType=Transaction&entityId=${txId}&limit=100`,
      );
      return (audit.body?.items ?? [])
        .map((e) => e.action)
        .filter((a) =>
          ['TRANSACTION_TRAVEL_RULE_ATTACHED', 'TRANSACTION_SCREENING', 'TRANSACTION_BROADCAST'].includes(a),
        );
    };

    const toxic = sabotaged('RS-05')
      ? null
      : await toxics.apply({
          proxy: 'ops-plane',
          type: 'limit_data',
          stream: 'upstream',
          attributes: { bytes: CUT_AFTER_BYTES },
        });

    // The officer's attach is torn mid-request: it must die at the transport
    // layer — the server never receives a complete body.
    expect(
      await diedAtTransport(() =>
        opsPlane.post(`/withdrawals/${txId}/travel-rule`, {
          body: TRAVEL_RULE_BODY(fx.runId),
          apiKey: API_KEYS.operatorA,
        }),
      ),
    ).toBe(true);

    // FAIL CLOSED, verified three ways via the clean plane: state unchanged,
    // zero gate-opening transitions audited, balance untouched.
    expect((await control.get<Withdrawal>(`/withdrawals/${txId}`)).body?.state).toBe('TRAVEL_RULE_CHECK');
    expect(await gateTransitions()).toEqual([]);
    expect((await control.get<{ balance: string }>(`/wallets/${fx.walletId}`)).body?.balance).toBe(
      BALANCE_GATED,
    );

    if (toxic !== null) await toxics.remove('ops-plane', toxic.name);

    // Recovery: the attach lands as a FIRST attach (201, no conflict) — proof
    // no partial Travel-Rule record survived the torn request — and the gate
    // opens through the full progression exactly once.
    const attached = await retryOnceOnTransportError('RS-05', () =>
      opsPlane.post<Withdrawal>(`/withdrawals/${txId}/travel-rule`, {
        body: TRAVEL_RULE_BODY(fx.runId),
        apiKey: API_KEYS.operatorA,
      }),
    );
    expect(attached.status).toBe(201);
    expect(attached.body?.state).toBe('PENDING_CONFIRMATION');
    expect((await control.get<{ balance: string }>(`/wallets/${fx.walletId}`)).body?.balance).toBe(
      BALANCE_SETTLED,
    );
    const after = await gateTransitions();
    expect(after.filter((a) => a === 'TRANSACTION_SCREENING')).toHaveLength(1);
    expect(after.filter((a) => a === 'TRANSACTION_BROADCAST')).toHaveLength(1);
  });
});
