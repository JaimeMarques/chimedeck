// Provenance conflicts must be fail-closed.
//
// [why] `import_provenance` is unique on (source_system, entity_type, source_id)
// AND on target_ref (db/migrations/0119_historical_import.ts): one source maps
// to at most one target, and one target to at most one source. A contradictory
// claim must be blocked, must not satisfy dependents, and must never be reported
// as an application when no write happened.
import { describe, expect, it } from 'bun:test';
import {
  applyPlan,
  dryRunPlan,
  observeDestination,
  validatePlan,
  type ApplyGates,
  type ImportPlan,
  type ImportOperation,
} from '../../../server/extensions/historicalImport/core/plan';
import { MemoryImporterDeps } from './harness';
import { SYNTH_IDENTITY_MAP, SYNTH_EXISTING_CARD, syntheticPlan } from './fixtures';

const OPERATOR = 'usr_operator_0001';
const CARD_TARGET = 'crd_synth_0200';
const OTHER_SOURCE = 'trello_card_other_9999';
const OTHER_PLAN_HASH = 'b'.repeat(64);
const COMMENT_PAYLOAD = 'file:///payloads/plan_synth_0001/op-comment-1.json';

function freshDeps(): MemoryImporterDeps {
  return new MemoryImporterDeps(SYNTH_IDENTITY_MAP);
}

function op(
  partial: Partial<ImportOperation> &
    Pick<ImportOperation, 'op_id' | 'entity_type' | 'source_id' | 'operation'>
): ImportOperation {
  return {
    target_id: undefined,
    provenance: {
      source_system: 'trello',
      source_id: partial.source_id,
      evidence_refs: [`trello-export:${partial.entity_type}/${partial.source_id}`],
    },
    evidence_refs: [`trello-export:${partial.entity_type}/${partial.source_id}`],
    expected_target_fingerprint: null,
    payload_ref: null,
    dependencies: [],
    ...partial,
  };
}

function nativeCard(id: string): Record<string, unknown> {
  return {
    id,
    list_id: 'lst_synth_0001',
    title: 'natively created card',
    description: null,
    position: '0000000000000001.000000',
    archived: false,
    due_date: null,
    due_complete: false,
    start_date: null,
  };
}

function seedForeignCardClaim(deps: MemoryImporterDeps, targetId: string): void {
  deps.rows.set(`card:${targetId}`, nativeCard(targetId));
  deps.provenance.push({
    id: 'prov-foreign-source',
    source_system: 'trello',
    entity_type: 'card',
    source_id: OTHER_SOURCE,
    target_id: targetId,
    target_ref: `card:${targetId}`,
    import_plan_hash: OTHER_PLAN_HASH,
    operation: 'create',
  });
}

async function gatesFor(plan: ImportPlan, deps: MemoryImporterDeps): Promise<ApplyGates> {
  const validation = await validatePlan(plan, deps, OPERATOR);
  expect(validation.ok).toBe(true);
  return {
    applyEnabled: true,
    confirmedPlanHash: validation.plan_hash,
    confirmedDestinationFingerprint: (await observeDestination(plan, deps)).fingerprint,
  };
}

type Outcome = { op_id: string; status: string; reason?: string; target_id?: string };
type Result = {
  outcomes: Outcome[];
  operations_applied: number;
  operations_noop: number;
  operations_blocked: number;
  operations_failed: number;
};

describe('provenance conflict — one target, two sources', () => {
  it('blocks a link onto a target claimed by another source and does not drain dependents', async () => {
    const deps = freshDeps();
    seedForeignCardClaim(deps, CARD_TARGET);
    const rowsBefore = deps.rows.size;

    const plan = syntheticPlan();
    plan.plan_id = 'plan_conflict_link';
    plan.operations = [
      op({
        op_id: 'op-link-conflict',
        entity_type: 'card',
        source_id: 'trello_card_synth_0002',
        operation: 'link',
        target_id: CARD_TARGET,
      }),
      op({
        op_id: 'op-dependent',
        entity_type: 'comment',
        source_id: 'trello_action_synth_c0001',
        operation: 'create',
        target_id: 'cmt_synth_9001',
        dependencies: ['op-link-conflict'],
        payload_ref: COMMENT_PAYLOAD,
        historical_author: 'm_synth_alice',
      } as Partial<ImportOperation> &
        Pick<ImportOperation, 'op_id' | 'entity_type' | 'source_id' | 'operation'>),
    ];

    const res = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as Result;

    const conflict = res.outcomes.find((o) => o.op_id === 'op-link-conflict')!;
    expect(conflict.status).toBe('blocked');
    expect(conflict.reason).toContain(OTHER_SOURCE);
    expect(res.outcomes.find((o) => o.op_id === 'op-dependent')!.status).toBe('blocked');
    expect(res.operations_applied).toBe(0);
    expect(res.operations_blocked).toBe(2);
    expect(deps.rows.size).toBe(rowsBefore);
    expect(deps.provenance).toHaveLength(1);
    expect(deps.provenance[0]!.source_id).toBe(OTHER_SOURCE);
  });

  it('blocks a create whose declared target_id is claimed by another source', async () => {
    const deps = freshDeps();
    seedForeignCardClaim(deps, SYNTH_EXISTING_CARD.id);
    const before = {
      ...(deps.rows.get(`card:${SYNTH_EXISTING_CARD.id}`) as Record<string, unknown>),
    };

    const plan = syntheticPlan();
    plan.plan_id = 'plan_conflict_create';
    plan.operations = [plan.operations[0]!];
    plan.operations[0]!.target_id = SYNTH_EXISTING_CARD.id;

    const res = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as Result;

    expect(res.outcomes[0]!.status).toBe('blocked');
    expect(res.outcomes[0]!.reason).toContain(OTHER_SOURCE);
    expect(res.operations_applied).toBe(0);
    expect(res.operations_noop).toBe(0);
    expect(res.operations_blocked).toBe(1);
    expect(deps.rows.get(`card:${SYNTH_EXISTING_CARD.id}`)).toEqual(before);
    expect(deps.provenance).toHaveLength(1);
  });

  it('keeps dry-run and apply identical for the conflict, writing nothing', async () => {
    const deps = freshDeps();
    seedForeignCardClaim(deps, CARD_TARGET);
    const rowsBefore = deps.rows.size;

    const plan = syntheticPlan();
    plan.plan_id = 'plan_conflict_dryrun';
    plan.operations = [
      op({
        op_id: 'op-link-conflict',
        entity_type: 'card',
        source_id: 'trello_card_synth_0002',
        operation: 'link',
        target_id: CARD_TARGET,
      }),
    ];

    const dry = (await dryRunPlan(plan, deps, OPERATOR)) as Result;
    const apply = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as Result;

    expect(dry.outcomes[0]!.status).toBe('blocked');
    expect(apply.outcomes[0]!.status).toBe('blocked');
    expect(dry.operations_applied).toBe(0);
    expect(deps.rows.size).toBe(rowsBefore);
    expect(deps.provenance).toHaveLength(1);
  });
});

describe('provenance conflict — adapter reports that it wrote nothing', () => {
  it('blocks when the source is already claimed against a different target', async () => {
    const deps = freshDeps();
    deps.provenance.push({
      id: 'prov-own-source',
      source_system: 'trello',
      entity_type: 'card',
      source_id: 'trello_card_synth_0001',
      target_id: 'crd_synth_0100',
      target_ref: 'card:crd_synth_0100',
      import_plan_hash: OTHER_PLAN_HASH,
      operation: 'create',
    });

    const plan = syntheticPlan();
    plan.plan_id = 'plan_conflict_source_axis';
    plan.operations = [plan.operations[0]!];

    const res = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as Result;

    expect(res.outcomes[0]!.status).toBe('blocked');
    expect(res.outcomes[0]!.reason).toContain('crd_synth_0100');
    expect(deps.provenance).toHaveLength(1);
    expect(deps.provenance[0]!.target_id).toBe('crd_synth_0100');
    expect(deps.rows.has('card:crd_synth_0001')).toBe(false);
    expect(res.operations_applied).toBe(0);
  });

  it('counts a no-op when createWithProvenance returns created:false for the same target', async () => {
    const deps = freshDeps();
    deps.createWithProvenance = async () => ({ target_id: 'crd_synth_0001', created: false });

    const plan = syntheticPlan();
    plan.plan_id = 'plan_conflict_race';
    plan.operations = [plan.operations[0]!];

    const res = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as Result;

    expect(res.outcomes[0]!.status).toBe('noop');
    expect(res.operations_applied).toBe(0);
    expect(res.operations_noop).toBe(1);
    expect(deps.provenance).toHaveLength(0);
  });

  it('blocks when the adapter resolves the source to a different target than the plan declared', async () => {
    const deps = freshDeps();
    deps.createWithProvenance = async () => ({ target_id: 'crd_synth_9999', created: false });

    const plan = syntheticPlan();
    plan.plan_id = 'plan_conflict_repoint';
    plan.operations = [plan.operations[0]!];

    const res = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as Result;

    expect(res.outcomes[0]!.status).toBe('blocked');
    expect(res.operations_applied).toBe(0);
    expect(res.operations_blocked).toBe(1);
  });
});

describe('provenance conflict — deterministic retry', () => {
  it('applies exactly once after resolution, then re-runs as a pure no-op', async () => {
    const deps = freshDeps();
    seedForeignCardClaim(deps, CARD_TARGET);

    const plan = syntheticPlan();
    plan.plan_id = 'plan_conflict_retry';
    plan.operations = [
      op({
        op_id: 'op-link-conflict',
        entity_type: 'card',
        source_id: 'trello_card_synth_0002',
        operation: 'link',
        target_id: CARD_TARGET,
      }),
    ];

    const blocked = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as Result;
    expect(blocked.outcomes[0]!.status).toBe('blocked');
    expect(deps.provenance).toHaveLength(1);

    deps.provenance = [];
    const first = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as Result;
    expect(first.operations_applied).toBe(1);
    expect(deps.provenance).toHaveLength(1);
    const rows = deps.rows.size;

    const second = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as Result;
    expect(second.operations_applied).toBe(0);
    expect(second.operations_noop).toBe(1);
    expect(deps.rows.size).toBe(rows);
    expect(deps.provenance.filter((p) => p.source_id === 'trello_card_synth_0002')).toHaveLength(1);
  });
});
