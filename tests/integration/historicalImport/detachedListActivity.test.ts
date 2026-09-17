import { describe, expect, it } from 'bun:test';
import {
  applyPlan,
  dryRunPlan,
  observeDestination,
  validatePlan,
  type ApplyGates,
  type ImportPlan,
} from '../../../server/extensions/historicalImport/core/plan';
import {
  canonicalJson,
  sha256Hex,
} from '../../../server/extensions/historicalImport/core/fingerprint';
import { MemoryImporterDeps, type StagedPayload } from './harness';

const OPERATOR = 'user-operator';
const BOARD_ID = 'board-phoenix';
const ACTION_ID = '69ef1718deba4fa60b205241';
const ACTIVITY_ID = 'activity-detached-list';
const SOURCE_MEMBER_ID = 'member-trello';
const TARGET_MEMBER_ID = 'user-chimedeck';
const LIST_SNAPSHOT = {
  id: '69ec7145872e59a8b0e141b8',
  name: 'Complete',
};
const SOURCE_ACTION = {
  id: ACTION_ID,
  type: 'deleteList',
  idMemberCreator: SOURCE_MEMBER_ID,
  date: '2026-04-14T19:35:20.000Z',
  data: {
    board: { id: 'trello-board', name: 'Phoenix' },
    list: LIST_SNAPSHOT,
  },
};
const PAYLOAD_REF = 'file:///payloads/detached-list/activity.json';

function sourceReference() {
  return {
    source_system: 'trello',
    entity_type: 'list',
    source_id: LIST_SNAPSHOT.id,
    relationship: 'subject',
    source_path: '/data/list',
    snapshot: LIST_SNAPSHOT,
    snapshot_sha256: sha256Hex(canonicalJson(LIST_SNAPSHOT)),
    source_snapshot_sha256: 'a'.repeat(64),
    evidence_ref: `trello:action:${ACTION_ID}#/data/list`,
  };
}

function stagedPayload(): StagedPayload {
  return {
    entity_type: 'activity',
    source_id: ACTION_ID,
    historical_author: SOURCE_MEMBER_ID,
    created_at: SOURCE_ACTION.date,
    source_references: [sourceReference()],
    fields: {
      entity_type: 'board',
      entity_id: BOARD_ID,
      board_id: BOARD_ID,
      action: 'legacy.trello.list_deleted',
      actor_id: TARGET_MEMBER_ID,
      payload: {
        detached_historical_list_reference: LIST_SNAPSHOT,
        historical_source_action: SOURCE_ACTION,
      },
    },
  };
}

function plan(): ImportPlan {
  return {
    plan_id: 'detached-list-activity-plan',
    source_system: 'trello',
    snapshot_hash: 'a'.repeat(64),
    created_at: '2026-09-17T00:00:00.000Z',
    operations: [
      {
        op_id: 'op-detached-list-activity',
        entity_type: 'activity',
        source_id: ACTION_ID,
        target_id: ACTIVITY_ID,
        operation: 'create',
        provenance: {
          source_system: 'trello',
          source_id: ACTION_ID,
          evidence_refs: [`trello:action:${ACTION_ID}`],
          board_id: BOARD_ID,
        },
        evidence_refs: [`trello:action:${ACTION_ID}`],
        expected_target_fingerprint: null,
        payload_ref: PAYLOAD_REF,
        dependencies: [],
        historical_author: SOURCE_MEMBER_ID,
      },
    ],
  };
}

function deps(): MemoryImporterDeps {
  const result = new MemoryImporterDeps(
    { [SOURCE_MEMBER_ID]: TARGET_MEMBER_ID },
    { [PAYLOAD_REF]: stagedPayload() }
  );
  result.rows.set(`board:${BOARD_ID}`, {
    id: BOARD_ID,
    workspace_id: 'workspace-phoenix',
  });
  return result;
}

async function gatesFor(candidate: ImportPlan, importer: MemoryImporterDeps): Promise<ApplyGates> {
  const validation = await validatePlan(candidate, importer, OPERATOR);
  expect(validation.ok).toBe(true);
  const observed = await observeDestination(candidate, importer);
  return {
    applyEnabled: true,
    confirmedPlanHash: validation.plan_hash,
    confirmedDestinationFingerprint: observed.fingerprint,
  };
}

describe('detached historical list activity provenance', () => {
  it('rehearses without writes, persists the raw detached reference on apply, and reruns as a no-op', async () => {
    const importer = deps();
    const candidate = plan();

    const dryRun = await dryRunPlan(candidate, importer, OPERATOR);
    expect(dryRun.operations_applied).toBe(1);
    expect(importer.rows.has(`activity:${ACTIVITY_ID}`)).toBe(false);
    expect(importer.provenance).toHaveLength(0);

    const applied = await applyPlan(
      candidate,
      await gatesFor(candidate, importer),
      importer,
      OPERATOR
    );
    expect('error' in applied).toBe(false);
    if ('error' in applied) return;
    expect(applied.operations_applied).toBe(1);
    expect(importer.rows.get(`activity:${ACTIVITY_ID}`)).toMatchObject({
      entity_type: 'board',
      entity_id: BOARD_ID,
      board_id: BOARD_ID,
      actor_id: TARGET_MEMBER_ID,
      action: 'legacy.trello.list_deleted',
      payload: {
        detached_historical_list_reference: LIST_SNAPSHOT,
        historical_source_action: SOURCE_ACTION,
      },
    });
    expect(importer.provenance[0]?.source_references).toEqual([sourceReference()]);
    expect(importer.rows.has(`list:${LIST_SNAPSHOT.id}`)).toBe(false);

    const rerun = await applyPlan(
      candidate,
      await gatesFor(candidate, importer),
      importer,
      OPERATOR
    );
    expect('error' in rerun).toBe(false);
    if ('error' in rerun) return;
    expect(rerun.operations_applied).toBe(0);
    expect(rerun.operations_noop).toBe(1);
  });

  it('fails closed when a rerun changes the detached source evidence', async () => {
    const importer = deps();
    const candidate = plan();
    const first = await applyPlan(
      candidate,
      await gatesFor(candidate, importer),
      importer,
      OPERATOR
    );
    expect('error' in first).toBe(false);
    if ('error' in first) return;
    expect(first.operations_applied).toBe(1);

    const changed = structuredClone(importer.payloadStore.get(PAYLOAD_REF)!);
    const changedList = { ...LIST_SNAPSHOT, name: 'Tampered' };
    changed.source_references![0]!.snapshot = changedList;
    changed.source_references![0]!.snapshot_sha256 = sha256Hex(canonicalJson(changedList));
    const activityPayload = changed.fields.payload as {
      detached_historical_list_reference: typeof LIST_SNAPSHOT;
      historical_source_action: typeof SOURCE_ACTION;
    };
    activityPayload.detached_historical_list_reference = changedList;
    activityPayload.historical_source_action.data.list = changedList;
    importer.payloadStore.set(PAYLOAD_REF, changed);

    const rerun = await applyPlan(
      candidate,
      await gatesFor(candidate, importer),
      importer,
      OPERATOR
    );
    expect('error' in rerun).toBe(false);
    if ('error' in rerun) return;
    expect(rerun.operations_failed).toBe(1);
    expect(rerun.outcomes[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('detached source references do not match stored provenance'),
    });
  });
});
