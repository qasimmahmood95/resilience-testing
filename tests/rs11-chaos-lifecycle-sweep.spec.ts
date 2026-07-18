/**
 * RS-11 - deterministic chaos sweep across a full withdrawal lifecycle
 *
 * Failure injected:   a FIXED rotation of non-destructive toxics (latency,
 *                     bandwidth), one per lifecycle step, on the plane that
 *                     step uses. Deterministic by construction - no random
 *                     schedule, no destructive cuts (ambiguous-outcome cases
 *                     are RS-02/03/04's job).
 * Expected behaviour: every step completes correctly, just slowly; latency-
 *                     toxified steps provably pay the injected latency.
 * Invariant:          the lifecycle is degradation-transparent end to end:
 *                     create -> dual approval -> Travel Rule gate -> attach ->
 *                     screening -> broadcast -> confirmation, with (a) balance
 *                     conservation `final = deposit - amount - fee` (the
 *                     external proxy for the unreadable ledger - F-07),
 *                     (b) every state transition audited exactly once,
 *                     (c) exactly one transaction.
 * Falsification:      FALSIFY=RS-11 skips all toxics - every latency-floor
 *                     assertion fires (the sweep cannot tell a degraded run
 *                     from a healthy one, so it must fail when undegraded).
 */
import { API_KEYS, BUDGET_FAST_MS, FAST_PATH_CEILING_MS } from './support/config.js';
import { sabotaged } from './support/falsify.js';
import { provisionFundedClient, type Withdrawal } from './support/provision.js';
import type { Problem } from './support/vaultchain.js';
import { expect, test } from './fixtures/index.js';

/** Per-step latency toxic; floors assert elapsed >= this. */
const STEP_LATENCY_MS = 800;
const DEGRADED_BUDGET_MS = STEP_LATENCY_MS + BUDGET_FAST_MS;
/** Cross-VASP + 1500.00 >= 1000.00 -> Travel Rule required; fee 10 bps = 1.50. */
const AMOUNT = '1500.00';
const DEPOSIT = '100000.00';
const FINAL_BALANCE = '98498.50';

interface AuditPage {
  items: { action: string }[];
}

test.describe('RS-11 chaos lifecycle sweep', () => {
  // Five degraded steps plus provisioning; comfortably above the default.
  test.setTimeout(90_000);

  test('a fully degraded lifecycle completes correctly, slowly, exactly once', async ({
    toxics,
    clientPlane,
    opsPlane,
    control,
  }) => {
    const fx = await provisionFundedClient(control, { depositAmount: DEPOSIT });
    const chaos = !sabotaged('RS-11');

    /** Run one lifecycle step under a latency toxic on the plane it uses. */
    async function degradedStep<T>(
      plane: 'client-plane' | 'ops-plane',
      run: () => Promise<T>,
    ): Promise<T> {
      const toxic = chaos
        ? await toxics.apply({
            proxy: plane,
            type: 'latency',
            stream: 'downstream',
            attributes: { latency: STEP_LATENCY_MS, jitter: 0 },
          })
        : null;
      const t0 = performance.now();
      const result = await run();
      const elapsed = performance.now() - t0;
      // The degradation floor: under chaos this step must have paid the
      // toll. This is the falsification hook - with toxics skipped it fires.
      expect(elapsed, `degraded step on ${plane} paid >= ${STEP_LATENCY_MS}ms`).toBeGreaterThanOrEqual(
        STEP_LATENCY_MS,
      );
      if (toxic !== null) await toxics.remove(plane, toxic.name);
      return result;
    }

    // Step 1 - create (client plane, cross-VASP so the Travel Rule gate arms).
    const created = await degradedStep('client-plane', () =>
      clientPlane.post<Withdrawal>('/withdrawals', {
        body: {
          walletId: fx.walletId,
          amount: AMOUNT,
          counterpartyAddress: fx.destAddress,
          counterpartyVaspId: `VASP-EXT-${fx.runId}`,
          idempotencyKey: `rs11-${fx.runId}`,
        },
        budgetMs: DEGRADED_BUDGET_MS,
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body?.state).toBe('PENDING_APPROVAL');
    const txId = created.body?.id;
    if (txId === undefined) throw new Error('creation returned no id');

    // Steps 2+3 - dual approval (ops plane), each under its own toxic.
    for (const [operator, expected] of [
      [API_KEYS.operatorA, 'PENDING_APPROVAL'],
      [API_KEYS.operatorB, 'TRAVEL_RULE_CHECK'],
    ] as const) {
      const approval = await degradedStep('ops-plane', () =>
        opsPlane.post<Withdrawal>(`/withdrawals/${txId}/approvals`, {
          body: { decision: 'APPROVE' },
          apiKey: operator,
          budgetMs: DEGRADED_BUDGET_MS,
        }),
      );
      expect(approval.status).toBe(201);
      expect(approval.body?.state).toBe(expected);
    }

    // Step 4 - Travel Rule attach (ops plane: the route is operator/
    // compliance-only): opens the gate; the server then screens (CLEAN) and
    // broadcasts in the same progression.
    const attached = await degradedStep('ops-plane', () =>
      opsPlane.post<Withdrawal | Problem>(`/withdrawals/${txId}/travel-rule`, {
        body: {
          originator: {
            name: 'RS-11 Originator',
            accountRef: `acct-${fx.runId}`,
            physicalAddress: '1 Resilience Way, Test City',
          },
          beneficiary: { name: 'RS-11 Beneficiary', accountRef: `bene-${fx.runId}` },
        },
        budgetMs: DEGRADED_BUDGET_MS,
      }),
    );
    expect(attached.status).toBe(201);
    expect((attached.body as Withdrawal).state).toBe('PENDING_CONFIRMATION');

    // Step 5 - confirmations via the control plane while the client plane is
    // still degraded: observation and simulator control must be PROVABLY
    // unaffected - the advance completes under the fast-path ceiling with the
    // toxic live (warm-up first, per FAST_PATH_CEILING_MS's contract).
    const settleToxic = chaos
      ? await toxics.apply({
          proxy: 'client-plane',
          type: 'latency',
          stream: 'downstream',
          attributes: { latency: STEP_LATENCY_MS, jitter: 0 },
        })
      : null;
    await control.get('/health');
    const s0 = performance.now();
    const advance = await control.post<{ settled: number }>('/simulator/chain/advance', {
      body: { blocks: 2 },
    });
    const advanceMs = performance.now() - s0;
    expect(advance.status).toBe(200);
    expect(advanceMs, 'control plane unaffected by client-plane degradation').toBeLessThan(
      FAST_PATH_CEILING_MS,
    );
    if (settleToxic !== null) await toxics.remove('client-plane', settleToxic.name);

    // Closing ground truth (control plane).
    const final = await control.get<Withdrawal>(`/withdrawals/${txId}`);
    expect(final.body?.state).toBe('CONFIRMED');

    // (a) Balance conservation - the external ledger proxy (F-07).
    const wallet = await control.get<{ balance: string }>(`/wallets/${fx.walletId}`);
    expect(wallet.body?.balance).toBe(FINAL_BALANCE);

    // (b) Every lifecycle transition audited EXACTLY once - degraded steps
    // never double-fired a transition.
    const audit = await control.get<AuditPage>(
      `/audit?entityType=Transaction&entityId=${txId}&limit=100`,
    );
    const actions = (audit.body?.items ?? []).map((e) => e.action);
    for (const transition of [
      'TRANSACTION_APPROVED',
      'TRANSACTION_TRAVEL_RULE_CHECK',
      'TRANSACTION_SCREENING',
      'TRANSACTION_BROADCAST',
      'TRANSACTION_PENDING_CONFIRMATION',
      'TRANSACTION_CONFIRMED',
    ]) {
      expect(actions.filter((a) => a === transition), transition).toHaveLength(1);
    }

    // (c) Exactly one transaction for the key.
    const list = await control.get<{ items: Withdrawal[] }>(
      `/withdrawals?walletId=${fx.walletId}&limit=100`,
    );
    expect(list.body?.items).toHaveLength(1);
  });
});
