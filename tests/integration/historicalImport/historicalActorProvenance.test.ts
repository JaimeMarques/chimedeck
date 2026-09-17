import { describe, expect, it } from 'bun:test';
import {
  applyPlan,
  observeDestination,
  validatePlan,
  type ApplyGates,
  type ImportPlan,
} from '../../../server/extensions/historicalImport/core/plan';
import { fingerprintJson } from '../../../server/extensions/historicalImport/core/fingerprint';
import { MemoryImporterDeps } from './harness';

const OPERATOR = 'usr_operator_synth';
const SOURCE_ACTOR = 'trello_member_synth';
const TARGET_ACTOR = 'usr_historical_synth';
const NATIVE_UPLOADER = 'usr_native_synth';
const TARGET_ATTACHMENT = 'att_existing_synth';

function attachmentLinkPlan(row: Record<string, unknown>): ImportPlan {
  return {
    plan_id: 'plan_attachment_actor_synth',
    source_system: 'trello',
    created_at: '2026-09-17T00:00:00.000Z',
    snapshot_hash: 'a'.repeat(64),
    operations: [
      {
        op_id: 'op-attachment-link-synth',
        entity_type: 'attachment',
        source_id: 'trello_attachment_synth',
        target_id: TARGET_ATTACHMENT,
        operation: 'link',
        provenance: {
          source_system: 'trello',
          source_id: 'trello_attachment_synth',
          evidence_refs: ['trello-export:attachments/trello_attachment_synth'],
        },
        evidence_refs: ['trello-export:attachments/trello_attachment_synth'],
        expected_target_fingerprint: fingerprintJson(row),
        payload_ref: null,
        dependencies: [],
        historical_author: SOURCE_ACTOR,
      },
    ],
  };
}

async function gates(plan: ImportPlan, deps: MemoryImporterDeps): Promise<ApplyGates> {
  const validation = await validatePlan(plan, deps, OPERATOR);
  expect(validation.ok).toBe(true);
  return {
    applyEnabled: true,
    confirmedPlanHash: validation.plan_hash,
    confirmedDestinationFingerprint: (await observeDestination(plan, deps)).fingerprint,
  };
}

describe('historical attachment actor provenance', () => {
  it('links without overwriting uploaded_by and stores both immutable actor identities', async () => {
    const deps = new MemoryImporterDeps({ [SOURCE_ACTOR]: TARGET_ACTOR });
    const row = {
      id: TARGET_ATTACHMENT,
      card_id: 'card_existing_synth',
      name: 'historical.png',
      type: 'FILE',
      uploaded_by: NATIVE_UPLOADER,
    };
    deps.rows.set(`attachment:${TARGET_ATTACHMENT}`, row);
    const plan = attachmentLinkPlan(row);

    const result = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.operations_applied).toBe(1);
    expect(deps.rows.get(`attachment:${TARGET_ATTACHMENT}`)?.uploaded_by).toBe(NATIVE_UPLOADER);
    expect(deps.provenance[0]).toMatchObject({
      entity_type: 'attachment',
      source_id: 'trello_attachment_synth',
      target_id: TARGET_ATTACHMENT,
      historical_source_actor_id: SOURCE_ACTOR,
      historical_target_actor_id: TARGET_ACTOR,
    });
  });

  it('blocks an idempotent rerun when stored historical actor provenance differs', async () => {
    const deps = new MemoryImporterDeps({ [SOURCE_ACTOR]: TARGET_ACTOR });
    const row = {
      id: TARGET_ATTACHMENT,
      card_id: 'card_existing_synth',
      name: 'historical.png',
      type: 'FILE',
      uploaded_by: NATIVE_UPLOADER,
    };
    deps.rows.set(`attachment:${TARGET_ATTACHMENT}`, row);
    const plan = attachmentLinkPlan(row);
    const first = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);
    expect('error' in first).toBe(false);
    deps.provenance[0]!.historical_target_actor_id = 'usr_tampered_synth';

    const second = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);

    expect('error' in second).toBe(false);
    if ('error' in second) return;
    expect(second.operations_blocked).toBe(1);
    expect(second.outcomes[0]).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('historical actor provenance'),
    });
  });
});
