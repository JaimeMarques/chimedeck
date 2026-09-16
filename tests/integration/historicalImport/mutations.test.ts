import { describe, expect, it } from 'bun:test';
import {
  applyPlan,
  observeDestination,
  validatePlan,
  type ApplyGates,
  type ImportPlan,
} from '../../../server/extensions/historicalImport/core/plan';
import {
  COMMENT_CORRECTION_FIELDS,
  fingerprintFields,
} from '../../../server/extensions/historicalImport/core/fingerprint';
import { MemoryImporterDeps } from './harness';
import { SYNTH_BOARD_ID, SYNTH_IDENTITY_MAP } from './fixtures';

const OPERATOR = 'usr_operator_0001';
const COMMENT_ID = 'cmt_existing_trello_0001';
const SOURCE_ID = 'trello_action_existing_0001';
const PAYLOAD_REF = 'file:///payloads/plan_mutations/op-correct-comment.json';

function originalComment(): Record<string, unknown> {
  return {
    id: COMMENT_ID,
    short_id: 'Cmt00001',
    card_id: 'crd_existing_trello_0001',
    user_id: 'usr_synth_bob',
    content: 'legacy imported text',
    parent_id: null,
    version: 1,
    deleted: false,
    created_at: '2026-01-10T09:00:00.000Z',
    updated_at: '2026-01-10T09:00:00.000Z',
  };
}

function correctionPlan(expected = originalComment()): ImportPlan {
  const expectedFields = Object.fromEntries(
    COMMENT_CORRECTION_FIELDS.map((field) => [field, expected[field] ?? null])
  );
  return {
    plan_id: 'plan_mutations_0001',
    source_system: 'trello',
    snapshot_hash: 'b'.repeat(64),
    created_at: '2026-09-16T00:00:00.000Z',
    operations: [
      {
        op_id: 'op-correct-comment',
        entity_type: 'comment',
        source_id: SOURCE_ID,
        target_id: COMMENT_ID,
        operation: 'correct',
        provenance: {
          source_system: 'trello',
          source_id: SOURCE_ID,
          evidence_refs: [`trello-export:actions/${SOURCE_ID}`],
          board_id: SYNTH_BOARD_ID,
        },
        evidence_refs: [`trello-export:actions/${SOURCE_ID}`],
        expected_target_fields: expectedFields,
        expected_target_fingerprint: fingerprintFields(expectedFields, COMMENT_CORRECTION_FIELDS),
        payload_ref: PAYLOAD_REF,
        dependencies: [],
        historical_author: 'm_synth_alice',
      },
    ],
  } as ImportPlan;
}

async function gates(plan: ImportPlan, deps: MemoryImporterDeps): Promise<ApplyGates> {
  const validation = await validatePlan(plan, deps, OPERATOR);
  expect(validation.ok).toBe(true);
  const destination = await observeDestination(plan, deps);
  return {
    applyEnabled: true,
    confirmedPlanHash: validation.plan_hash,
    confirmedDestinationFingerprint: destination.fingerprint,
  };
}

function depsForCorrection(): MemoryImporterDeps {
  const deps = new MemoryImporterDeps(SYNTH_IDENTITY_MAP, {
    [PAYLOAD_REF]: {
      entity_type: 'comment',
      source_id: SOURCE_ID,
      historical_author: 'm_synth_alice',
      created_at: '2026-01-09T08:00:00.000Z',
      updated_at: '2026-01-09T08:00:00.000Z',
      fields: {
        content: 'correct Trello text',
        parent_id: null,
      },
    },
  });
  deps.rows.set(`comment:${COMMENT_ID}`, originalComment());
  return deps;
}

describe('historical import mutations', () => {
  it('corrects a proven Trello comment and writes provenance atomically', async () => {
    const deps = depsForCorrection();
    const plan = correctionPlan();

    const result = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.operations_applied).toBe(1);
    const row = deps.rows.get(`comment:${COMMENT_ID}`)!;
    expect(row).toMatchObject({
      user_id: 'usr_synth_alice',
      content: 'correct Trello text',
      parent_id: null,
      created_at: '2026-01-09T08:00:00.000Z',
      updated_at: '2026-01-09T08:00:00.000Z',
    });
    expect(deps.provenance).toHaveLength(1);
    expect(deps.provenance[0]).toMatchObject({
      entity_type: 'comment',
      source_id: SOURCE_ID,
      target_id: COMMENT_ID,
      operation: 'correct',
    });
  });

  it('keeps correction dry-run write-free and makes the second apply a no-op', async () => {
    const deps = depsForCorrection();
    const plan = correctionPlan();
    const before = structuredClone(deps.rows.get(`comment:${COMMENT_ID}`));

    const dryRun = await import('../../../server/extensions/historicalImport/core/plan').then(
      ({ dryRunPlan }) => dryRunPlan(plan, deps, OPERATOR)
    );
    expect(dryRun.operations_applied).toBe(1);
    expect(deps.rows.get(`comment:${COMMENT_ID}`)).toEqual(before);
    expect(deps.provenance).toHaveLength(0);

    await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);
    const second = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);
    expect('error' in second).toBe(false);
    if ('error' in second) return;
    expect(second.operations_applied).toBe(0);
    expect(second.operations_noop).toBe(1);
    expect(deps.provenance).toHaveLength(1);
  });

  it('blocks correction when any expected comment field drifted', async () => {
    const deps = depsForCorrection();
    const plan = correctionPlan();
    deps.rows.get(`comment:${COMMENT_ID}`)!.content = 'native edit after evidence';

    const result = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.operations_blocked).toBe(1);
    expect(deps.rows.get(`comment:${COMMENT_ID}`)!.content).toBe('native edit after evidence');
    expect(deps.provenance).toHaveLength(0);
  });

  it('enriches only an empty card cover and then reruns as a no-op', async () => {
    const deps = new MemoryImporterDeps(SYNTH_IDENTITY_MAP, {
      'file:///payloads/plan_mutations/op-enrich-cover.json': {
        entity_type: 'card',
        source_id: 'trello_card_cover_1',
        fields: { cover_attachment_id: null, cover_color: '#1D4ED8', cover_size: 'FULL' },
      },
    });
    const cardId = 'crd_existing_cover_1';
    const preimage = { cover_attachment_id: null, cover_color: null, cover_size: 'SMALL' };
    deps.rows.set(`card:${cardId}`, { id: cardId, ...preimage });
    const plan = {
      plan_id: 'plan_enrich_1',
      source_system: 'trello',
      snapshot_hash: 'c'.repeat(64),
      created_at: '2026-09-16T00:00:00.000Z',
      operations: [
        {
          op_id: 'op-enrich-cover',
          entity_type: 'card',
          source_id: 'trello_card_cover_1',
          target_id: cardId,
          operation: 'enrich',
          provenance: {
            source_system: 'trello',
            source_id: 'trello_card_cover_1',
            evidence_refs: ['trello-export:cards/1'],
            board_id: SYNTH_BOARD_ID,
          },
          evidence_refs: ['trello-export:cards/1'],
          expected_target_fields: preimage,
          expected_target_fingerprint: fingerprintFields(preimage, [
            'cover_attachment_id',
            'cover_color',
            'cover_size',
          ]),
          payload_ref: 'file:///payloads/plan_mutations/op-enrich-cover.json',
          dependencies: [],
        },
      ],
    } as ImportPlan;

    const first = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);
    expect('error' in first).toBe(false);
    expect(deps.rows.get(`card:${cardId}`)).toMatchObject({
      cover_color: '#1D4ED8',
      cover_size: 'FULL',
    });
    const second = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);
    expect('error' in second).toBe(false);
    if ('error' in second) return;
    expect(second.operations_noop).toBe(1);
    expect(deps.provenance).toHaveLength(1);
  });
});
