// tests/integration/historicalImport/stateGates.test.ts
// State-divergence gates: the frozen source snapshot (snapshot_hash) and the
// destination-state fingerprint.
//
// [why] `snapshot_hash` used to be shape-validated only (any 64-hex string
// passed validate and dry-run), and apply had no witness of the destination
// state at all: a plan could be confirmed against one state and executed
// against another. Both stops are pinned here.
import { describe, expect, it } from 'bun:test';
import {
  applyPlan,
  dryRunPlan,
  observeDestination,
  validatePlan,
  type ApplyGates,
  type ImportPlan,
} from '../../../server/extensions/historicalImport/core/plan';
import { MemoryImporterDeps } from './harness';
import { SYNTH_IDENTITY_MAP, SYNTH_EXISTING_CARD, syntheticPlan } from './fixtures';

const OPERATOR = 'usr_operator_0001';
const FROZEN = '2673fe79b97198b605e75159f5a4a27452ade348c9cade76fb01ba8c19a1eb84';

function freshDeps(): MemoryImporterDeps {
  return new MemoryImporterDeps(SYNTH_IDENTITY_MAP);
}

function frozenPlan(): ImportPlan {
  const plan = syntheticPlan();
  plan.snapshot_hash = FROZEN;
  return plan;
}

async function gatesFor(plan: ImportPlan, deps: MemoryImporterDeps): Promise<ApplyGates> {
  const v = await validatePlan(plan, deps, OPERATOR);
  expect(v.ok).toBe(true);
  return {
    applyEnabled: true,
    confirmedPlanHash: v.plan_hash,
    confirmedDestinationFingerprint: (await observeDestination(plan, deps)).fingerprint,
  };
}

// ---------------------------------------------------------------------------
// Snapshot pinning
// ---------------------------------------------------------------------------

describe('snapshot hash enforcement', () => {
  it('accepts a plan whose snapshot_hash matches the frozen value', async () => {
    const deps = freshDeps();
    const v = await validatePlan(frozenPlan(), deps, OPERATOR, { expectedSnapshotHash: FROZEN });
    expect(v.ok).toBe(true);
    expect(v.snapshot_hash_pinned).toBe(true);
    expect(v.errors.some((e) => e.code === 'snapshot-divergence')).toBe(false);
  });

  it('stops a plan whose snapshot_hash was swapped for another valid 64-hex value', async () => {
    const deps = freshDeps();
    const plan = frozenPlan();
    plan.snapshot_hash = 'b'.repeat(64); // shape-valid, semantically wrong
    const v = await validatePlan(plan, deps, OPERATOR, { expectedSnapshotHash: FROZEN });
    expect(v.ok).toBe(false);
    const err = v.errors.find((e) => e.code === 'snapshot-divergence')!;
    expect(err).toBeDefined();
    expect(err.message).toContain('diverges from the frozen snapshot hash');
    // the error must not leak the full expected hash
    expect(err.message).not.toContain(FROZEN);
  });

  it('requires a snapshot_hash when pinning is enabled', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    delete (plan as { snapshot_hash?: string }).snapshot_hash;
    const v = await validatePlan(plan, deps, OPERATOR, { expectedSnapshotHash: FROZEN });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.code === 'snapshot-divergence')).toBe(true);
  });

  it('warns (but does not fail) when no frozen hash is configured', async () => {
    const deps = freshDeps();
    const v = await validatePlan(syntheticPlan(), deps, OPERATOR);
    expect(v.ok).toBe(true);
    expect(v.snapshot_hash_pinned).toBe(false);
    expect(v.warnings.some((w) => w.code === 'snapshot-hash-unpinned')).toBe(true);
  });

  it('refuses dry-run and apply for a diverged snapshot', async () => {
    const deps = freshDeps();
    const plan = frozenPlan();
    plan.snapshot_hash = 'c'.repeat(64);
    const expectations = { expectedSnapshotHash: FROZEN };

    const dry = (await dryRunPlan(plan, deps, OPERATOR, expectations)) as {
      validation_errors?: unknown;
    };
    expect(dry.validation_errors).toBeDefined();

    const applied = await applyPlan(
      plan,
      {
        applyEnabled: true,
        confirmedPlanHash: (await validatePlan(plan, deps, OPERATOR)).plan_hash,
        confirmedDestinationFingerprint: (await observeDestination(plan, deps)).fingerprint,
        expectations,
      },
      deps,
      OPERATOR
    );
    expect('error' in applied && applied.code === 'snapshot-divergence').toBe(true);
    expect(deps.rows.size).toBe(1); // nothing written
  });
});

// ---------------------------------------------------------------------------
// Destination-state fingerprint
// ---------------------------------------------------------------------------

describe('destination state fingerprint', () => {
  it('is stable across repeated observations of the same state', async () => {
    const deps = freshDeps();
    const a = await observeDestination(syntheticPlan(), deps);
    const b = await observeDestination(syntheticPlan(), deps);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it('changes when a target row that the plan touches changes (drift)', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const before = await observeDestination(plan, deps);
    deps.rows.set(`card:${SYNTH_EXISTING_CARD.id}`, { ...SYNTH_EXISTING_CARD });
    const after = await observeDestination(
      { ...plan, operations: [{ ...plan.operations[0]!, target_id: SYNTH_EXISTING_CARD.id }] },
      deps
    );
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('changes when a target gains provenance (claim drift)', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const before = await observeDestination(plan, deps);
    deps.rows.set('card:crd_synth_0001', { id: 'crd_synth_0001', title: 'native' });
    deps.provenance.push({
      id: 'prov-1',
      source_system: 'trello',
      entity_type: 'card',
      source_id: 'someone_else',
      target_id: 'crd_synth_0001',
      target_ref: 'card:crd_synth_0001',
      import_plan_hash: 'd'.repeat(64),
      operation: 'link',
    });
    const after = await observeDestination(plan, deps);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('refuses apply when the destination fingerprint is not confirmed', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const v = await validatePlan(plan, deps, OPERATOR);
    const res = await applyPlan(
      plan,
      { applyEnabled: true, confirmedPlanHash: v.plan_hash },
      deps,
      OPERATOR
    );
    expect('error' in res && res.code === 'destination-state-unconfirmed').toBe(true);
    expect(deps.rows.size).toBe(1);
    expect(deps.provenance.length).toBe(0);
  });

  it('refuses apply when the destination changed after the confirmation', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const gates = await gatesFor(plan, deps);

    // Someone touches a row the plan is about to link to.
    deps.rows.set('label:lbl_synth_0001', {
      id: 'lbl_synth_0001',
      board_id: 'brd_synth_0001',
      name: 'Renamed by a human',
      color: '#61BD4F',
    });
    deps.rows.set(`card:${SYNTH_EXISTING_CARD.id}`, { ...SYNTH_EXISTING_CARD, title: 'changed' });

    const res = await applyPlan(plan, gates, deps, OPERATOR);
    expect('error' in res && res.code === 'destination-state-divergence').toBe(true);
    expect(deps.provenance.length).toBe(0); // fail-closed: no writes
    expect(deps.rows.get(`card:${SYNTH_EXISTING_CARD.id}`)!.title).toBe('changed'); // not overwritten
  });

  it('applies when the confirmed fingerprint matches the observed state', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const gates = await gatesFor(plan, deps);
    const res = (await applyPlan(plan, gates, deps, OPERATOR)) as { operations_applied: number };
    expect(res.operations_applied).toBe(6);
  });

  it('binds the fingerprint to the plan hash it was observed for', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const v = await validatePlan(plan, deps, OPERATOR);
    const tampered = syntheticPlan();
    tampered.operations[0]!.payload_ref = 'file:///payloads/other.json';
    const res = await applyPlan(
      tampered,
      {
        applyEnabled: true,
        confirmedPlanHash: v.plan_hash,
        confirmedDestinationFingerprint: v.destination_fingerprint,
      },
      deps,
      OPERATOR
    );
    expect('error' in res && res.code === 'plan-hash-mismatch').toBe(true);
  });
});
