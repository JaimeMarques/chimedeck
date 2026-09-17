// tests/integration/historicalImport/resetRecovery.test.ts
// Reset vs. recovery.
//
// [why] A provenance-only reset left the plan's created rows behind, so the
// next apply blocked every create with "already exists without provenance" and
// the only documented way back was a database restore. The plain reset now
// reports exactly which rows it is leaving behind, and an explicitly
// authorized recovery deletes the rows this plan created (never anything else)
// so a corrected plan can be re-executed without a restore.
import { describe, expect, it } from 'bun:test';
import {
  applyPlan,
  observeDestination,
  recoverPlan,
  resetPlan,
  validatePlan,
  type ApplyGates,
  type ImportPlan,
} from '../../../server/extensions/historicalImport/core/plan';
import { MemoryImporterDeps } from './harness';
import { SYNTH_IDENTITY_MAP, syntheticPlan } from './fixtures';

const OPERATOR = 'usr_operator_0001';

function freshDeps(): MemoryImporterDeps {
  return new MemoryImporterDeps(SYNTH_IDENTITY_MAP);
}

async function applyAll(plan: ImportPlan, deps: MemoryImporterDeps) {
  const v = await validatePlan(plan, deps, OPERATOR);
  expect(v.ok).toBe(true);
  const gates: ApplyGates = {
    applyEnabled: true,
    confirmedPlanHash: v.plan_hash,
    confirmedDestinationFingerprint: (await observeDestination(plan, deps)).fingerprint,
  };
  return applyPlan(plan, gates, deps, OPERATOR);
}

describe('reset — provenance-only', () => {
  it('reports the rows it leaves behind (no more silent re-apply failure)', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    await applyAll(plan, deps);

    const res = await resetPlan(
      (await validatePlan(plan, deps, OPERATOR)).plan_hash,
      deps,
      OPERATOR
    );
    expect(res.cleared).toBe(6);
    expect(res.recovery).toBe('provenance-only');
    // 5 creates + 1 link: only the creates are reported as blocking rows.
    expect(res.created_targets_remaining.length).toBe(5);
    expect(res.created_targets_remaining.map((t) => t.target_id)).toContain('crd_synth_0001');
    expect(res.recovery_note).toContain('restoring the pre-apply backup');
    expect(deps.rows.size).toBe(6); // entity rows remain (unchanged semantics)
  });

  it('records the created targets in the audit log so recovery survives a reset', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    await applyAll(plan, deps);
    const hash = (await validatePlan(plan, deps, OPERATOR)).plan_hash;

    await resetPlan(hash, deps, OPERATOR);
    const audit = deps.audit.filter((a) => a.action === 'reset').pop()!;
    const detail = audit.detail as {
      created_targets?: Array<{ entity_type: string; target_id: string }>;
    };
    expect(detail.created_targets).toBeDefined();
    // The adapter reconstructs the delete set from this list when provenance is
    // already gone (probe: PROBE/qa/evidence/remediation-join-state-reset.json).
    expect(detail.created_targets!.length).toBe(5);
    expect(detail.created_targets!.map((t) => t.entity_type)).toContain('card');
  });

  it('still blocks re-apply after a provenance-only reset', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const first = (await applyAll(plan, deps)) as { operations_applied: number };
    expect(first.operations_applied).toBe(6);
    await resetPlan((await validatePlan(plan, deps, OPERATOR)).plan_hash, deps, OPERATOR);
    const again = (await applyAll(plan, deps)) as {
      operations_applied: number;
      operations_blocked: number;
      outcomes: Array<{ op_id: string; status: string; reason?: string }>;
    };
    expect(again.operations_blocked).toBe(5);
    expect(again.outcomes.find((o) => o.op_id === 'op-card-1')!.reason).toContain(
      'overwrite prohibited'
    );
  });
});

describe('reset — destructive recovery', () => {
  it('is refused unless the server gate is enabled', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    await applyAll(plan, deps);
    const hash = (await validatePlan(plan, deps, OPERATOR)).plan_hash;

    const res = await recoverPlan(hash, deps, OPERATOR, {
      confirmDestructive: true,
      recoveryEnabled: false,
    });
    expect('error' in res && res.code === 'recovery-disabled').toBe(true);
    expect(deps.rows.size).toBe(6); // nothing deleted
  });

  it('is refused without the explicit destructive confirmation', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    await applyAll(plan, deps);
    const hash = (await validatePlan(plan, deps, OPERATOR)).plan_hash;

    const res = await recoverPlan(hash, deps, OPERATOR, {
      confirmDestructive: false,
      recoveryEnabled: true,
    });
    expect('error' in res && res.code === 'destructive-confirmation-required').toBe(true);
    expect(deps.rows.size).toBe(6);
  });

  it('deletes only the rows the plan created and clears its provenance', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    await applyAll(plan, deps);
    const hash = (await validatePlan(plan, deps, OPERATOR)).plan_hash;

    const report = await recoverPlan(hash, deps, OPERATOR, {
      confirmDestructive: true,
      recoveryEnabled: true,
    });
    expect('error' in report).toBe(false);
    const ok = report as { ok: boolean; deleted: number; provenance_cleared: number };
    expect(ok.ok).toBe(true);
    expect(ok.deleted).toBe(5); // the 5 created rows
    expect(ok.provenance_cleared).toBe(6); // creates + the link
    // pre-seeded native row survives
    expect(deps.rows.has('label:lbl_synth_0001')).toBe(true);
    expect(deps.rows.has('card:crd_synth_0001')).toBe(false);
    expect(deps.provenance.length).toBe(0);
  });

  it('lets the same plan re-apply cleanly after recovery (QA-6 revisited)', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    await applyAll(plan, deps);
    const hash = (await validatePlan(plan, deps, OPERATOR)).plan_hash;
    await recoverPlan(hash, deps, OPERATOR, { confirmDestructive: true, recoveryEnabled: true });

    const reapply = (await applyAll(plan, deps)) as {
      operations_applied: number;
      operations_blocked: number;
    };
    expect(reapply.operations_applied).toBe(6);
    expect(reapply.operations_blocked).toBe(0);
    expect(deps.rows.size).toBe(6); // pre-seeded label + 5 recreated rows, no duplicates
  });

  it('refuses (and deletes nothing) when a blocker is reported by the adapter', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    await applyAll(plan, deps);
    const hash = (await validatePlan(plan, deps, OPERATOR)).plan_hash;
    deps.injectedRecoveryBlockers = [
      { code: 'recovery-non-cascade-dependency', detail: 'native child would be mutated' },
    ];

    const report = await recoverPlan(hash, deps, OPERATOR, {
      confirmDestructive: true,
      recoveryEnabled: true,
    });
    const res = report as { ok: boolean; deleted: number; blockers: Array<{ code: string }> };
    expect(res.ok).toBe(false);
    expect(res.deleted).toBe(0);
    expect(res.blockers[0]!.code).toBe('recovery-non-cascade-dependency');
    expect(deps.rows.size).toBe(6); // fail-closed
    expect(deps.provenance.length).toBe(6);
  });

  it('audits the recovery attempt with the operator as actor, including refusals', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    await applyAll(plan, deps);
    const hash = (await validatePlan(plan, deps, OPERATOR)).plan_hash;
    deps.injectedRecoveryBlockers = [{ code: 'recovery-fk-cycle', detail: 'cycle' }];

    await recoverPlan(hash, deps, OPERATOR, { confirmDestructive: true, recoveryEnabled: true });
    const audit = deps.audit.filter((a) => a.action === 'reset');
    expect(audit.length).toBe(1);
    expect(audit[0]!.actor_user_id).toBe(OPERATOR);
    expect(audit[0]!.import_plan_hash).toBe(hash);
    expect((audit[0]!.detail as { mode: string }).mode).toBe('recovery');
    expect((audit[0]!.detail as { ok: boolean }).ok).toBe(false);
  });
});
