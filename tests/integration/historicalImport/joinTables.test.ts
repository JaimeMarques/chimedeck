// tests/integration/historicalImport/joinTables.test.ts
// Join-table (composite-key) operations: card_labels and card_members.
//
// [why] These two destination tables have a composite primary key and NO `id`
// column. Before this work the adapter addressed them by id, so every
// join-table operation failed on a real Postgres
// ("column \"id\" does not exist"). These tests pin the composite-key
// contract end to end at the engine level: identity, dedupe, native-content
// protection, drift and failure messages.
import { describe, expect, it } from 'bun:test';
import {
  applyPlan,
  observeDestination,
  validatePlan,
  type ApplyGates,
  type ImportOperation,
  type ImportPlan,
} from '../../../server/extensions/historicalImport/core/plan';
import { MemoryImporterDeps } from './harness';
import { SYNTH_BOARD_ID, SYNTH_IDENTITY_MAP, syntheticPlan, SYNTH_LIST_ID } from './fixtures';

const OPERATOR = 'usr_operator_0001';
const CARD_TARGET = 'crd_synth_0001';
const LABEL_ID = 'lbl_synth_0001'; // pre-seeded natively by the harness
const MEMBER_ID = 'usr_synth_bob'; // resolved historical member

function joinOp(
  partial: Partial<ImportOperation> & Pick<ImportOperation, 'op_id' | 'entity_type' | 'source_id'>
): ImportOperation {
  return {
    operation: 'create',
    target_id: undefined,
    provenance: {
      source_system: 'trello',
      source_id: partial.source_id,
      evidence_refs: [`trello-export:${partial.entity_type}/${partial.source_id}`],
      board_id: SYNTH_BOARD_ID,
    },
    evidence_refs: [`trello-export:${partial.entity_type}/${partial.source_id}`],
    expected_target_fingerprint: null,
    payload_ref: null,
    dependencies: [],
    ...partial,
  };
}

// The synthetic plan (card + comment + attachment + checklist + label link)
// plus the two join-table creates, depending on the card.
function planWithJoins(labelTargetId?: string, memberTargetId?: string): ImportPlan {
  const plan = syntheticPlan();
  plan.plan_id = 'plan_synth_joins';
  plan.operations = [
    ...plan.operations,
    joinOp({
      op_id: 'op-card-label-1',
      entity_type: 'card_label',
      source_id: 'trello_cardlabel_synth_0001',
      target_id: labelTargetId ?? `${CARD_TARGET}:${LABEL_ID}`,
      dependencies: ['op-card-1'],
    }),
    joinOp({
      op_id: 'op-card-member-1',
      entity_type: 'card_member',
      source_id: 'trello_cardmember_synth_0001',
      target_id: memberTargetId ?? `${CARD_TARGET}:${MEMBER_ID}`,
      dependencies: ['op-card-1'],
    }),
  ];
  return plan;
}

function freshDeps(): MemoryImporterDeps {
  // card_label:lab_... is intentionally NOT pre-seeded here; individual tests
  // seed native join rows when they need to prove overwrite protection.
  return new MemoryImporterDeps(SYNTH_IDENTITY_MAP);
}

async function gatesFor(plan: ImportPlan, deps: MemoryImporterDeps): Promise<ApplyGates> {
  const v = await validatePlan(plan, deps, OPERATOR);
  expect(v.ok).toBe(true);
  const observed = await observeDestination(plan, deps);
  return {
    applyEnabled: true,
    confirmedPlanHash: v.plan_hash,
    confirmedDestinationFingerprint: observed.fingerprint,
  };
}

describe('join tables — validation', () => {
  it('accepts a composite target_id for card_label and card_member', async () => {
    const deps = freshDeps();
    const v = await validatePlan(planWithJoins(), deps, OPERATOR);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('requires a composite target_id (no id column to synthesise)', async () => {
    const deps = freshDeps();
    const plan = planWithJoins();
    plan.operations[6]!.target_id = undefined;
    const v = await validatePlan(plan, deps, OPERATOR);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.code === 'composite-target-required')).toBe(true);
  });

  it('rejects a malformed composite target_id', async () => {
    const deps = freshDeps();
    const v = await validatePlan(planWithJoins(CARD_TARGET), deps, OPERATOR); // single part
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.code === 'composite-target-invalid')).toBe(true);
  });
});

describe('join tables — apply', () => {
  it('creates the join rows without an id column and with a composite provenance ref', async () => {
    const deps = freshDeps();
    const plan = planWithJoins();
    const res = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as {
      operations_applied: number;
      outcomes: Array<{ status: string; op_id: string }>;
    };
    expect(res.operations_applied).toBe(8);

    const row = deps.rows.get(`card_label:${CARD_TARGET}:${LABEL_ID}`)!;
    expect(row).toBeDefined();
    expect(row['id']).toBeUndefined(); // never writes an id column
    expect(row['card_id']).toBe(CARD_TARGET);
    expect(row['label_id']).toBe(LABEL_ID);

    const prov = deps.provenance.find((p) => p.source_id === 'trello_cardlabel_synth_0001')!;
    expect(prov.target_id).toBe(`${CARD_TARGET}:${LABEL_ID}`);
    expect(prov.target_ref).toBe(`card_label:${CARD_TARGET}:${LABEL_ID}`);

    const member = deps.rows.get(`card_member:${CARD_TARGET}:${MEMBER_ID}`)!;
    expect(member['user_id']).toBe(MEMBER_ID);
    expect(member['id']).toBeUndefined();
  });

  it('is idempotent: a second run is a full no-op', async () => {
    const deps = freshDeps();
    const plan = planWithJoins();
    await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR);
    const second = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as {
      operations_applied: number;
      operations_noop: number;
    };
    expect(second.operations_applied).toBe(0);
    expect(second.operations_noop).toBe(8);
    expect(deps.provenance.filter((p) => p.entity_type === 'card_label').length).toBe(1);
  });

  it('refuses to claim a native join row (composite key already exists, no provenance)', async () => {
    const deps = freshDeps();
    deps.rows.set(`card_label:${CARD_TARGET}:${LABEL_ID}`, {
      card_id: CARD_TARGET,
      label_id: LABEL_ID,
    });
    const plan = planWithJoins();
    const res = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as {
      outcomes: Array<{ status: string; op_id: string; reason?: string }>;
    };
    const outcome = res.outcomes.find((o) => o.op_id === 'op-card-label-1')!;
    expect(outcome.status).toBe('blocked');
    expect(outcome.reason).toContain('overwrite prohibited');
    // native row untouched, no provenance written for it
    expect(deps.provenance.some((p) => p.entity_type === 'card_label')).toBe(false);
  });

  it('links an existing join row instead of recreating it', async () => {
    const deps = freshDeps();
    deps.rows.set(`card_member:${CARD_TARGET}:${MEMBER_ID}`, {
      card_id: CARD_TARGET,
      user_id: MEMBER_ID,
    });
    const plan = planWithJoins();
    plan.operations[7]!.operation = 'link';
    const res = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as {
      outcomes: Array<{ status: string; op_id: string }>;
    };
    expect(res.outcomes.find((o) => o.op_id === 'op-card-member-1')!.status).toBe('applied');
    expect(
      deps.provenance.some((p) => p.target_ref === `card_member:${CARD_TARGET}:${MEMBER_ID}`)
    ).toBe(true);
  });

  it('blocks a link whose composite target does not exist', async () => {
    const deps = freshDeps();
    const plan = planWithJoins();
    plan.operations[7]!.operation = 'link';
    const res = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as {
      outcomes: Array<{ status: string; op_id: string; reason?: string }>;
    };
    const outcome = res.outcomes.find((o) => o.op_id === 'op-card-member-1')!;
    expect(outcome.status).toBe('blocked');
    expect(outcome.reason).toContain('not found');
  });

  it('fails the operation (fail-fast) when the payload disagrees with the composite key', async () => {
    const deps = freshDeps();
    const plan = planWithJoins();
    // A staged payload that contradicts the target_id key must never be written.
    deps.payloadStore.set('file:///payloads/join.json', {
      entity_type: 'card_label',
      source_id: 'trello_cardlabel_synth_0001',
      fields: { card_id: CARD_TARGET, label_id: 'lbl_other' },
    } as never);
    plan.operations[6]!.payload_ref = 'file:///payloads/join.json';
    const res = (await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR)) as {
      operations_failed: number;
      outcomes: Array<{ status: string; op_id: string; reason?: string }>;
    };
    expect(res.operations_failed).toBe(1);
    const outcome = res.outcomes.find((o) => o.op_id === 'op-card-label-1')!;
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('disagrees with the target_id key');
    expect(deps.rows.has(`card_label:${CARD_TARGET}:lbl_other`)).toBe(false);
  });

  it('keeps the card member’s user_id as the resolved historical member', async () => {
    const deps = freshDeps();
    const plan = planWithJoins();
    await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR);
    const member = deps.rows.get(`card_member:${CARD_TARGET}:${MEMBER_ID}`)!;
    expect(member['user_id']).not.toBe(OPERATOR);
    expect(member['user_id']).toBe('usr_synth_bob');
  });
});

describe('join tables — destination state', () => {
  it('observes the composite row and changes the fingerprint when it drifts', async () => {
    const deps = freshDeps();
    const plan = planWithJoins();
    const before = await observeDestination(plan, deps);
    expect(before.entries.find((e) => e.entity_type === 'card_label')!.row_present).toBe(false);

    deps.rows.set(`card_label:${CARD_TARGET}:${LABEL_ID}`, {
      card_id: CARD_TARGET,
      label_id: LABEL_ID,
    });
    const drift = await observeDestination(plan, deps);
    expect(drift.entries.find((e) => e.entity_type === 'card_label')!.row_present).toBe(true);
    expect(drift.fingerprint).not.toBe(before.fingerprint);
  });
});
