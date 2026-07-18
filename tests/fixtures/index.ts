// Shared fixtures. Two hygiene guarantees live here (CLAUDE.md determinism
// policy):
//  1. LEAK DETECTION — every test (auto fixture, not opt-in) fails loudly at
//     setup if it inherits toxics from a previous test, instead of silently
//     running degraded.
//  2. GUARANTEED TEARDOWN — every toxic is removed after each test, pass or
//     fail. A control-plane toxic is checked BEFORE the sweep and is always a
//     hard failure: it means observation itself was compromised (ADR-0002).

import { test as base, expect } from '@playwright/test';
import { API_KEYS, NEVER_TOXIFIED } from '../support/config.js';
import {
  addToxic,
  listAllToxics,
  removeAllToxics,
  removeToxic,
  type AddToxicInput,
  type Toxic,
} from '../support/toxiproxy.js';
import { VaultChainClient } from '../support/vaultchain.js';

export interface ToxicHandle {
  /** Apply a toxic; it is auto-removed in teardown even if the test fails. */
  apply(input: AddToxicInput): Promise<Toxic>;
  /** Remove one toxic early (e.g. to model recovery mid-test). */
  remove(proxy: AddToxicInput['proxy'], name: string): Promise<void>;
  /** Remove every toxic THIS test applied (mid-test recovery; no-op if none). */
  removeAllApplied(): Promise<void>;
}

interface Fixtures {
  /** Auto fixture: leak detection + final sweep for EVERY test. */
  _toxicHygiene: void;
  /** Toxic applicator (opt-in) with per-test teardown of what it applied. */
  toxics: ToxicHandle;
  /** Canonical sim state: POST /simulator/reset (chain/clock/fault state — not the DB). */
  cleanSimState: void;
  /** CLIENT-actor client on the (degradable) client plane. */
  clientPlane: VaultChainClient;
  /** Operator/compliance client on the (degradable) ops plane. */
  opsPlane: VaultChainClient;
  /** Ground-truth client on the never-toxified control plane (admin key). */
  control: VaultChainClient;
}

const fmt = (ts: { proxy: string; toxic: string }[]): string =>
  ts.map((t) => `${t.proxy}/${t.toxic}`).join(', ');

export const test = base.extend<Fixtures>({
  _toxicHygiene: [
    async ({}, use, testInfo) => {
      // Setup: a clean slate is an invariant, not a hope — for every test,
      // including ones that never touch toxics themselves.
      const inherited = await listAllToxics();
      if (inherited.length > 0) {
        await removeAllToxics(); // unpoison the NEXT test before failing this one
        throw new Error(`Toxic leak from a previous test (this run is poisoned): ${fmt(inherited)}`);
      }

      await use(undefined);

      // Teardown (runs AFTER the `toxics` fixture removed what it applied):
      // inspect BEFORE sweeping, or the assertions below can never fail.
      const remaining = await listAllToxics();
      await removeAllToxics();
      const onControl = remaining.filter((t) => t.proxy === NEVER_TOXIFIED);
      if (onControl.length > 0) {
        // Always fatal, pass or fail: the observation plane was compromised,
        // so this test's own evidence is untrustworthy (ADR-0002).
        throw new Error(`${NEVER_TOXIFIED} carried toxics during this test: ${fmt(onControl)}`);
      }
      if (remaining.length > 0 && testInfo.status === 'passed') {
        throw new Error(`Test passed but leaked toxics (teardown bug in the test): ${fmt(remaining)}`);
      }
    },
    { auto: true },
  ],

  toxics: async ({ _toxicHygiene }, use) => {
    const applied: { proxy: AddToxicInput['proxy']; name: string }[] = [];
    const handle: ToxicHandle = {
      async apply(input) {
        if (input.proxy === NEVER_TOXIFIED) {
          throw new Error(`Refusing to toxify ${NEVER_TOXIFIED}: it is the observation plane (ADR-0002)`);
        }
        const toxic = await addToxic(input);
        applied.push({ proxy: input.proxy, name: toxic.name });
        return toxic;
      },
      async remove(proxy, name) {
        await removeToxic(proxy, name);
        const i = applied.findIndex((t) => t.proxy === proxy && t.name === name);
        if (i >= 0) applied.splice(i, 1);
      },
      async removeAllApplied() {
        while (applied.length > 0) {
          // applied is non-empty inside the loop; shift() cannot return undefined.
          const t = applied.shift() as { proxy: AddToxicInput['proxy']; name: string };
          await removeToxic(t.proxy, t.name);
        }
      },
    };

    await use(handle);

    // Remove what this test applied; _toxicHygiene sweeps and judges the rest.
    for (const t of applied) {
      try {
        await removeToxic(t.proxy, t.name);
      } catch {
        // Already gone — the hygiene sweep will catch anything left.
      }
    }
  },

  cleanSimState: async ({ control }, use) => {
    const res = await control.post('/simulator/reset');
    if (res.status !== 200) {
      throw new Error(`/simulator/reset failed: ${res.status}`);
    }
    await use(undefined);
  },

  clientPlane: async ({}, use) => {
    await use(new VaultChainClient('client', API_KEYS.client01));
  },
  opsPlane: async ({}, use) => {
    await use(new VaultChainClient('ops', API_KEYS.operatorA));
  },
  control: async ({}, use) => {
    await use(new VaultChainClient('control', API_KEYS.admin));
  },
});

export { expect };
