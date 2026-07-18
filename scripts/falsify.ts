// Falsification harness (CLAUDE.md hard limit 3: no vacuous passes).
//
// For each scenario, re-run its spec with FALSIFY=<id>, which activates the
// documented sabotage inside the test (typically: the toxic is silently not
// applied). Under sabotage the test MUST fail - a test that still passes with
// its fault removed cannot detect the fault and is worthless. The harness
// exits non-zero (failing the build) if ANY scenario survives sabotage.
//
// Exit codes are NOT trusted as detection: `playwright test --grep` with zero
// matches also exits 1, and a crashed/timed-out spawn has status null - both
// must read as harness failures, never as "OK, it failed under sabotage". The
// JSON reporter's stats are the evidence: at least one test must have RUN and
// at least one must have FAILED.
//
// Run against an already-up stack: `npm run falsify`.

import { spawnSync } from 'node:child_process';

/** Scenario id -> grep that selects exactly that spec. */
const SCENARIOS: readonly { id: string; grep: string }[] = [
  { id: 'RS-01', grep: 'RS-01' },
  { id: 'RS-02', grep: 'RS-02' },
  { id: 'RS-03', grep: 'RS-03' },
  { id: 'RS-04', grep: 'RS-04' },
  { id: 'RS-05', grep: 'RS-05' },
  { id: 'RS-06', grep: 'RS-06' },
  { id: 'RS-07', grep: 'RS-07' },
  { id: 'RS-08', grep: 'RS-08' },
  { id: 'RS-09', grep: 'RS-09' },
  { id: 'RS-10', grep: 'RS-10' },
  { id: 'RS-11', grep: 'RS-11' },
  { id: 'RS-12', grep: 'RS-12' },
];

type Verdict =
  | { kind: 'detected'; ran: number; failed: number }
  | { kind: 'vacuous'; ran: number }
  | { kind: 'harness-failure'; reason: string };

function runSabotaged(id: string, grep: string): Verdict {
  const run = spawnSync('npx', ['playwright', 'test', '--grep', grep, '--reporter=json'], {
    env: { ...process.env, FALSIFY: id },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
  // On any non-detection outcome, surface the child's own output - a bare
  // verdict with no diagnostics is useless in CI.
  const dumpChild = (why: string): void => {
    console.error(`--- ${id}: ${why}; child output follows ---`);
    if (run.stdout) console.error(run.stdout.slice(-4_000));
    if (run.stderr) console.error(run.stderr.slice(-4_000));
    console.error(`--- end ${id} child output ---`);
  };

  if (run.error !== undefined) {
    dumpChild(`spawn error: ${run.error.message}`);
    return { kind: 'harness-failure', reason: `spawn error: ${run.error.message}` };
  }
  if (run.status === null) {
    dumpChild(`killed (signal ${run.signal ?? 'unknown'})`);
    return { kind: 'harness-failure', reason: `killed (signal ${run.signal ?? 'unknown'})` };
  }

  let stats: { expected: number; unexpected: number; skipped: number; flaky: number };
  try {
    const report = JSON.parse(run.stdout) as { stats: typeof stats };
    stats = report.stats;
  } catch {
    dumpChild(`unparseable reporter output (exit ${run.status})`);
    return { kind: 'harness-failure', reason: `unparseable reporter output (exit ${run.status})` };
  }

  const ran = stats.expected + stats.unexpected + stats.flaky;
  if (ran === 0) {
    dumpChild(`grep '${grep}' matched no tests`);
    return { kind: 'harness-failure', reason: `grep '${grep}' matched no tests` };
  }
  if (stats.unexpected === 0) {
    dumpChild(`VACUOUS: ${ran} test(s) passed with sabotage active`);
    return { kind: 'vacuous', ran };
  }
  return { kind: 'detected', ran, failed: stats.unexpected };
}

let vacuousOrBroken = 0;
console.log('=== Falsification: every scenario must FAIL with its sabotage active ===');
for (const scenario of SCENARIOS) {
  const verdict = runSabotaged(scenario.id, scenario.grep);
  switch (verdict.kind) {
    case 'detected':
      console.log(`  ${scenario.id}: OK - ${verdict.failed}/${verdict.ran} test(s) failed under sabotage`);
      break;
    case 'vacuous':
      console.error(`  ${scenario.id}: VACUOUS - ${verdict.ran} test(s) PASSED with the fault removed`);
      vacuousOrBroken += 1;
      break;
    case 'harness-failure':
      console.error(`  ${scenario.id}: HARNESS FAILURE - ${verdict.reason}`);
      vacuousOrBroken += 1;
      break;
  }
}

if (vacuousOrBroken > 0) {
  console.error(
    `\n${vacuousOrBroken} scenario(s) vacuous or unverifiable. A resilience test that cannot fail is worthless (CLAUDE.md hard limit 3).`,
  );
  process.exit(1);
}
console.log('\nAll scenarios fail under sabotage - no vacuous passes.');
