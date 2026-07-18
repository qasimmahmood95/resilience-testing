/**
 * RS-09 - asymmetric partition: clients dark, compliance healthy
 *
 * Failure injected:   timeout toxic (hold forever), upstream, client-plane
 *                     ONLY - the ops plane stays healthy. A realistic partial
 *                     outage: the customer edge is down, internal operations
 *                     are not.
 * Expected behaviour: client requests abort at their budgets; the compliance
 *                     officer's hold-resolution workflow proceeds unimpeded
 *                     on the ops plane.
 * Invariant:          segregation of duties survives partial degradation -
 *                     a client-plane outage can neither block nor corrupt
 *                     compliance resolution, and the reconnecting client
 *                     observes the correctly-resolved state.
 * Falsification:      FALSIFY=RS-09 skips the toxic - the client-plane
 *                     dark-probe assertion fires (the probe just succeeds).
 */
import { API_KEYS, FAST_PATH_CEILING_MS } from './support/config.js';
import { sabotaged } from './support/falsify.js';
import { provisionFundedClient, type Withdrawal } from './support/provision.js';
import { retryOnceOnTransportError } from './support/transport.js';
import { expect, test } from './fixtures/index.js';

/** Dark-probe patience; see RS-02's ABORT_BUDGET_MS derivation. */
const ABORT_BUDGET_MS = 1_500;
const AMOUNT = '500.00';
const DEPOSIT = '100000.00';
const BALANCE_SETTLED = '99499.50';

interface Hold {
  id: string;
  state: string;
  transactionId: string;
}

test.describe('RS-09 asymmetric partition', () => {
  test('compliance resolves a hold while the client edge is dark', async ({
    toxics,
    clientPlane,
    opsPlane,
    control,
    cleanSimState,
  }) => {
    // Clears the global one-shot screeningNext slot (cross-test poisoning
    // guard - see RS-06).
    void cleanSimState;
    const fx = await provisionFundedClient(control, { depositAmount: DEPOSIT });

    // A flagged withdrawal parked in HELD, before any partition.
    expect(
      (await control.post('/simulator/screening/next', { body: { outcome: 'FLAG' } })).status,
    ).toBe(200);
    const created = await clientPlane.post<Withdrawal>('/withdrawals', {
      body: {
        walletId: fx.walletId,
        amount: AMOUNT,
        counterpartyAddress: fx.destAddress,
        idempotencyKey: `rs09-${fx.runId}`,
      },
    });
    expect(created.status).toBe(201);
    const txId = created.body?.id;
    if (txId === undefined) throw new Error('creation returned no id');
    const approval = await opsPlane.post<Withdrawal>(`/withdrawals/${txId}/approvals`, {
      body: { decision: 'APPROVE' },
      apiKey: API_KEYS.operatorA,
    });
    expect(approval.body?.state).toBe('HELD');
    const holds = await control.get<{ items: Hold[] }>('/holds?state=OPEN&limit=100');
    const hold = holds.body?.items.find((h) => h.transactionId === txId);
    if (hold === undefined) throw new Error('no OPEN hold found for the flagged withdrawal');

    // The partition: clients go dark; operations do not.
    if (!sabotaged('RS-09')) {
      await toxics.apply({
        proxy: 'client-plane',
        type: 'timeout',
        stream: 'upstream',
        attributes: { timeout: 0 },
      });
    }

    // Clients are provably dark...
    await expect(
      clientPlane.get(`/withdrawals/${txId}`, { budgetMs: ABORT_BUDGET_MS }),
    ).rejects.toThrow(/timeout|abort/i);

    // ...while the officer's workflow runs at full speed on the ops plane:
    // read the hold, release it - both fast, both correct. (Warm-up first,
    // per FAST_PATH_CEILING_MS's contract.)
    await opsPlane.get('/health', { apiKey: API_KEYS.compliance });
    const t0 = performance.now();
    const view = await opsPlane.get<Hold>(`/holds/${hold.id}`, { apiKey: API_KEYS.compliance });
    const release = await opsPlane.post<Hold>(`/holds/${hold.id}/release`, {
      apiKey: API_KEYS.compliance,
    });
    const officerMs = performance.now() - t0;
    expect(view.status).toBe(200);
    expect(view.body?.state).toBe('OPEN');
    expect(release.status).toBe(200);
    expect(officerMs, 'officer workflow unimpeded during client outage').toBeLessThan(
      2 * FAST_PATH_CEILING_MS,
    );

    // Resolution is complete and correct while clients are still dark.
    expect((await control.get<Hold>(`/holds/${hold.id}`)).body?.state).toBe('RELEASED');
    expect((await control.get<Withdrawal>(`/withdrawals/${txId}`)).body?.state).toBe('PENDING_CONFIRMATION');
    expect((await control.get<{ balance: string }>(`/wallets/${fx.walletId}`)).body?.balance).toBe(
      BALANCE_SETTLED,
    );

    // The partition heals; the reconnecting client sees the resolved state.
    // (Removing a timeout toxic severs held connections - the reconnect may
    // hit a poisoned pooled socket once; see transport.ts.)
    await toxics.removeAllApplied();
    const reconnected = await retryOnceOnTransportError('RS-09', () =>
      clientPlane.get<Withdrawal>(`/withdrawals/${txId}`),
    );
    expect(reconnected.status).toBe(200);
    expect(reconnected.body?.state).toBe('PENDING_CONFIRMATION');
  });
});
