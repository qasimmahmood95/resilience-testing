// Per-test state provisioning through the PUBLIC API only - exactly what an
// external integrator could do. All calls go via the control plane so toxics
// can never corrupt setup. Each test gets a fresh account, so scenarios are
// isolated from the seed dataset and from each other.

import { randomUUID } from 'node:crypto';
import { API_KEYS } from './config.js';
import type { VaultChainClient } from './vaultchain.js';

/** Sim-clock cooling-off window for allowlisted addresses (VaultChain D9: 24h). */
const COOLING_OFF_MS = 86_400_000;

/** GBPX: 1 required confirmation (seed-lib), so 2 blocks always credit a deposit. */
const CREDIT_BLOCKS = 2;

export interface FundedClientFixture {
  /** Unique per provision run; printed so failures are reproducible/traceable. */
  runId: string;
  clientId: string;
  accountId: string;
  /** GBPX wallet id, funded with `depositAmount`. */
  walletId: string;
  /** Allowlisted + cooling-off-elapsed destination address. */
  destAddress: string;
}

interface Account {
  id: string;
  wallets: { id: string; assetSymbol: string }[];
}

/**
 * Create a funded, withdrawal-ready GBPX fixture for CLIENT #1:
 * account -> simulated deposit -> chain advance (credits it) -> allowlisted
 * destination -> sim-clock advance past cooling-off.
 *
 * NOTE: sim clock and chain height are GLOBAL - this is only safe because the
 * suite is serialized (workers: 1).
 */
export async function provisionFundedClient(
  control: VaultChainClient,
  opts: { depositAmount?: string } = {},
): Promise<FundedClientFixture> {
  const runId = randomUUID().slice(0, 8);
  // Printed on purpose: identifiers below embed runId, so any leftover state
  // in a locally persistent DB is attributable to a specific test run.
  console.log(`[provision] runId=${runId}`);

  const me = await control.get<{ clientId: string }>('/me', { apiKey: API_KEYS.client01 });
  if (me.status !== 200 || typeof me.body?.clientId !== 'string') {
    throw new Error(`provision: /me for client01 failed (${me.status})`);
  }
  const clientId = me.body.clientId;

  const account = await control.post<Account>('/accounts', {
    body: {
      clientId,
      label: `rs-fixture-${runId}`,
      segregationModel: 'SEGREGATED',
      assets: ['GBPX'],
    },
  });
  if (account.status !== 201 || account.body === undefined) {
    throw new Error(`provision: POST /accounts failed (${account.status})`);
  }
  const wallet = account.body.wallets.find((w) => w.assetSymbol === 'GBPX');
  if (wallet === undefined) throw new Error('provision: created account has no GBPX wallet');

  const deposit = await control.post(`/wallets/${wallet.id}/deposits/simulate`, {
    body: { amount: opts.depositAmount ?? '100000.00', chainTxRef: `rs-dep-${runId}` },
  });
  if (deposit.status !== 201) throw new Error(`provision: deposit simulate failed (${deposit.status})`);

  const advance = await control.post('/simulator/chain/advance', { body: { blocks: CREDIT_BLOCKS } });
  if (advance.status !== 200) throw new Error(`provision: chain advance failed (${advance.status})`);

  const destAddress = `rs-dest-${runId}`;
  const allow = await control.post(`/accounts/${account.body.id}/allowlist`, {
    body: { assetSymbol: 'GBPX', address: destAddress, label: `rs-dest-${runId}` },
  });
  if (allow.status !== 201) throw new Error(`provision: allowlist add failed (${allow.status})`);

  const clock = await control.post('/simulator/clock/advance', {
    body: { ms: String(COOLING_OFF_MS + 1) },
  });
  if (clock.status !== 200) throw new Error(`provision: clock advance failed (${clock.status})`);

  return { runId, clientId, accountId: account.body.id, walletId: wallet.id, destAddress };
}

/** Serialized withdrawal shape (subset we assert on) - VaultChain serializeTx. */
export interface Withdrawal {
  id: string;
  walletId: string;
  state: string;
  amount: string;
  idempotencyKey: string | null;
}

/** Count withdrawals for a wallet carrying a given idempotency key (ground truth). */
export async function countByIdempotencyKey(
  control: VaultChainClient,
  walletId: string,
  key: string,
): Promise<number> {
  const page = await control.get<{ items: Withdrawal[]; nextCursor: string | null }>(
    `/withdrawals?walletId=${walletId}&limit=100`,
  );
  if (page.status !== 200 || page.body === undefined) {
    throw new Error(`countByIdempotencyKey: list failed (${page.status})`);
  }
  if (page.body.nextCursor !== null) {
    throw new Error('countByIdempotencyKey: unexpected pagination - fixture wallet has >100 withdrawals');
  }
  return page.body.items.filter((w) => w.idempotencyKey === key).length;
}
