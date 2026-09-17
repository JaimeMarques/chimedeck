// tests/integration/historicalImport/fixtures.ts
// Synthetic fixtures for the historical-import tests. No PII: all ids,
// names, emails and content are generated/synthetic.
import type { ImportPlan, ImportOperation } from '../../../server/extensions/historicalImport/core/plan';
import { fingerprintFields, CARD_FINGERPRINT_FIELDS } from '../../../server/extensions/historicalImport/core/fingerprint';

export const SYNTH_WORKSPACE_ID = 'ws_synth_0001';
export const SYNTH_BOARD_ID = 'brd_synth_0001';
export const SYNTH_LIST_ID = 'lst_synth_0001';

export const SYNTH_USERS = {
  operator: { id: 'usr_operator_0001', email: 'operator@synth.test' },
  alice: { id: 'usr_synth_alice', email: 'alice@synth.test' }, // maps trello m_synth_alice
  bob: { id: 'usr_synth_bob', email: 'bob@synth.test' }, // maps trello m_synth_bob
  ghost: { id: 'm_synth_ghost', email: 'ghost@synth.test' }, // unresolved trello id
};

export const SYNTH_IDENTITY_MAP: Record<string, string> = {
  m_synth_alice: 'usr_synth_alice',
  m_synth_bob: 'usr_synth_bob',
};

// A synthetic Trello card already existing in the destination (drift tests)
export const SYNTH_EXISTING_CARD = {
  id: 'crd_synth_0100',
  list_id: SYNTH_LIST_ID,
  title: 'Existing synthetic card',
  description: 'native content',
  position: '0000000000000100.000000',
  archived: false,
  due_date: null,
  due_complete: false,
  start_date: null,
};

export function existingCardFingerprint(): string {
  return fingerprintFields(SYNTH_EXISTING_CARD, CARD_FINGERPRINT_FIELDS);
}

function baseOp(partial: Partial<ImportOperation> & Pick<ImportOperation, 'op_id' | 'entity_type' | 'source_id' | 'operation'>): ImportOperation {
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

// A full synthetic plan: create card + comment by a historical author +
// attachment + checklist + label link + reaction + mention.
export function syntheticPlan(): ImportPlan {
  return {
    plan_id: 'plan_synth_0001',
    source_system: 'trello',
    created_at: '2026-09-16T00:00:00.000Z',
    snapshot_hash: 'a'.repeat(64),
    operations: [
      baseOp({
        op_id: 'op-card-1',
        entity_type: 'card',
        source_id: 'trello_card_synth_0001',
        operation: 'create',
        target_id: 'crd_synth_0001',
        payload_ref: 'file:///payloads/plan_synth_0001/op-card-1.json',
        provenance: { source_system: 'trello', source_id: 'trello_card_synth_0001', evidence_refs: ['trello-export:cards/trello_card_synth_0001'], board_id: SYNTH_BOARD_ID },
      }),
      baseOp({
        op_id: 'op-comment-1',
        entity_type: 'comment',
        source_id: 'trello_action_synth_c0001',
        operation: 'create',
        target_id: 'cmt_synth_0001',
        dependencies: ['op-card-1'],
        payload_ref: 'file:///payloads/plan_synth_0001/op-comment-1.json',
        provenance: { source_system: 'trello', source_id: 'trello_action_synth_c0001', evidence_refs: ['trello-export:actions/trello_action_synth_c0001'], board_id: SYNTH_BOARD_ID },
        historical_author: 'm_synth_alice',
      } as ImportOperation & { historical_author: string }),
      baseOp({
        op_id: 'op-attach-1',
        entity_type: 'attachment',
        source_id: 'trello_attach_synth_0001',
        operation: 'create',
        target_id: 'att_synth_0001',
        dependencies: ['op-card-1'],
        payload_ref: 'file:///payloads/plan_synth_0001/op-attach-1.json',
        provenance: { source_system: 'trello', source_id: 'trello_attach_synth_0001', evidence_refs: ['trello-export:attachments/trello_attach_synth_0001'], board_id: SYNTH_BOARD_ID },
      }),
      baseOp({
        op_id: 'op-checklist-1',
        entity_type: 'checklist',
        source_id: 'trello_checklist_synth_0001',
        operation: 'create',
        target_id: 'chl_synth_0001',
        dependencies: ['op-card-1'],
        payload_ref: 'file:///payloads/plan_synth_0001/op-checklist-1.json',
        provenance: { source_system: 'trello', source_id: 'trello_checklist_synth_0001', evidence_refs: ['trello-export:checklists/trello_checklist_synth_0001'], board_id: SYNTH_BOARD_ID },
      }),
      baseOp({
        op_id: 'op-checklist-item-1',
        entity_type: 'checklist_item',
        source_id: 'trello_checkitem_synth_0001',
        operation: 'create',
        target_id: 'chi_synth_0001',
        dependencies: ['op-checklist-1'],
        payload_ref: 'file:///payloads/plan_synth_0001/op-checklist-item-1.json',
        provenance: { source_system: 'trello', source_id: 'trello_checkitem_synth_0001', evidence_refs: ['trello-export:checkItems/trello_checkitem_synth_0001'], board_id: SYNTH_BOARD_ID },
      }),
      baseOp({
        op_id: 'op-label-link-1',
        entity_type: 'label',
        source_id: 'trello_label_synth_0001',
        operation: 'link',
        target_id: 'lbl_synth_0001',
        dependencies: [],
        provenance: { source_system: 'trello', source_id: 'trello_label_synth_0001', evidence_refs: ['trello-export:labels/trello_label_synth_0001'], board_id: SYNTH_BOARD_ID },
      }),
    ],
  };
}
// Synthetic staged payload files (what resolveStagedPayload reads on disk).
export const SYNTH_PAYLOADS: Record<string, unknown> = {
  'file:///payloads/plan_synth_0001/op-card-1.json': {
    entity_type: 'card',
    source_id: 'trello_card_synth_0001',
    historical_author: 'm_synth_alice',
    created_at: '2026-01-15T10:00:00.000Z',
    updated_at: '2026-02-20T08:30:00.000Z',
    fields: {
      list_id: SYNTH_LIST_ID,
      title: 'Synthetic historical card',
      description: 'body written by alice in trello',
      position: '0000000000000005.000000',
      archived: false,
    },
  },
  'file:///payloads/plan_synth_0001/op-comment-1.json': {
    entity_type: 'comment',
    source_id: 'trello_action_synth_c0001',
    historical_author: 'm_synth_alice',
    created_at: '2026-01-16T11:20:00.000Z',
    updated_at: '2026-01-16T11:20:00.000Z',
    fields: {
      card_id: 'crd_synth_0001',
      content: 'historic comment mentioning @bob',
    },
  },
  'file:///payloads/plan_synth_0001/op-attach-1.json': {
    entity_type: 'attachment',
    source_id: 'trello_attach_synth_0001',
    historical_author: 'm_synth_bob',
    created_at: '2026-01-17T09:00:00.000Z',
    fields: {
      card_id: 'crd_synth_0001',
      uploaded_by: 'usr_synth_bob',
      name: 'synthetic-spec.pdf',
      type: 'FILE',
      s3_key: 'imports/synthetic-spec.pdf',
      s3_bucket: 'chimedeck',
      mime_type: 'application/pdf',
      size_bytes: 2048,
      status: 'READY',
    },
  },
  'file:///payloads/plan_synth_0001/op-checklist-1.json': {
    entity_type: 'checklist',
    source_id: 'trello_checklist_synth_0001',
    created_at: '2026-01-18T12:00:00.000Z',
    fields: {
      card_id: 'crd_synth_0001',
      title: 'Synthetic checklist',
      position: '0000000000000001.000000',
    },
  },
  'file:///payloads/plan_synth_0001/op-checklist-item-1.json': {
    entity_type: 'checklist_item',
    source_id: 'trello_checkitem_synth_0001',
    created_at: '2026-01-18T12:05:00.000Z',
    fields: {
      card_id: 'crd_synth_0001',
      checklist_id: 'chl_synth_0001',
      title: 'synthetic step one',
      checked: true,
      position: '0000000000000001.000000',
    },
  },
};
