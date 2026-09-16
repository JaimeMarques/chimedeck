// tests/integration/historicalImport/coverChain.test.ts
// The constrained cover chain: one source identity may appear twice in a plan
// ONLY as a card `create|link` immediately followed by that card's `enrich`,
// with the enrich depending directly on the materialisation and on the
// import-owned cover attachment.
//
// [why] Attachment-backed covers on newly created cards need
// `card create -> attachment create -> card enrich`, but validation rejected the
// second card operation as `duplicate-source`, and using a second source id
// conflicts with the unique provenance claim for the target. Either way,
// recoverable covers were non-executable. The allowance is deliberately narrow:
// every other duplicate source/target case stays rejected.
import { describe, expect, it } from 'bun:test';
import {
  applyPlan,
  dryRunPlan,
  observeDestination,
  validatePlan,
  type ApplyGates,
  type ImportOperation,
  type ImportPlan,
} from '../../../server/extensions/historicalImport/core/plan';
import {
  CARD_COVER_FIELDS,
  CARD_FINGERPRINT_FIELDS,
  fingerprintFields,
} from '../../../server/extensions/historicalImport/core/fingerprint';
import { MemoryImporterDeps } from './harness';
import { SYNTH_BOARD_ID, SYNTH_IDENTITY_MAP, SYNTH_LIST_ID } from './fixtures';

const OPERATOR = 'usr_operator_0001';

const CARD_SOURCE = 'trello_card_cover_chain_0001';
const CARD_ID = 'crd_cover_chain_0001';
const ATT_SOURCE = 'trello_attach_cover_chain_0001';
const ATT_ID = 'att_cover_chain_0001';

const CARD_PAYLOAD = 'file:///payloads/plan_cover_chain/op-card.json';
const ATT_PAYLOAD = 'file:///payloads/plan_cover_chain/op-attach.json';
const ENRICH_PAYLOAD = 'file:///payloads/plan_cover_chain/op-enrich.json';

const EMPTY_COVER = { cover_attachment_id: null, cover_color: null, cover_size: 'SMALL' } as const;

function emptyCoverFingerprint(): string {
  return fingerprintFields(EMPTY_COVER, CARD_COVER_FIELDS);
}

function op(
  partial: Partial<ImportOperation> & Pick<ImportOperation, 'op_id' | 'entity_type' | 'source_id' | 'operation'>
): ImportOperation {
  return {
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

// create -> attachment create -> cover enrich
function createChainPlan(): ImportPlan {
  return {
    plan_id: 'plan_cover_chain_0001',
    source_system: 'trello',
    snapshot_hash: 'a'.repeat(64),
    created_at: '2026-09-16T00:00:00.000Z',
    operations: [
      op({
        op_id: 'op-card-create',
        entity_type: 'card',
        source_id: CARD_SOURCE,
        operation: 'create',
        target_id: CARD_ID,
        payload_ref: CARD_PAYLOAD,
      }),
      op({
        op_id: 'op-attachment-create',
        entity_type: 'attachment',
        source_id: ATT_SOURCE,
        operation: 'create',
        target_id: ATT_ID,
        dependencies: ['op-card-create'],
        payload_ref: ATT_PAYLOAD,
      }),
      op({
        op_id: 'op-cover-enrich',
        entity_type: 'card',
        source_id: CARD_SOURCE,
        operation: 'enrich',
        target_id: CARD_ID,
        dependencies: ['op-card-create', 'op-attachment-create'],
        payload_ref: ENRICH_PAYLOAD,
        expected_target_fields: { ...EMPTY_COVER },
        expected_target_fingerprint: emptyCoverFingerprint(),
      }),
    ],
  };
}

// link (native existing card) -> attachment create -> cover enrich
function linkChainPlan(nativeCard: Record<string, unknown>): ImportPlan {
  return {
    plan_id: 'plan_cover_chain_link_0001',
    source_system: 'trello',
    snapshot_hash: 'a'.repeat(64),
    created_at: '2026-09-16T00:00:00.000Z',
    operations: [
      op({
        op_id: 'op-card-link',
        entity_type: 'card',
        source_id: CARD_SOURCE,
        operation: 'link',
        target_id: CARD_ID,
        expected_target_fingerprint: fingerprintFields(nativeCard, CARD_FINGERPRINT_FIELDS),
      }),
      op({
        op_id: 'op-attachment-create',
        entity_type: 'attachment',
        source_id: ATT_SOURCE,
        operation: 'create',
        target_id: ATT_ID,
        dependencies: ['op-card-link'],
        payload_ref: ATT_PAYLOAD,
      }),
      op({
        op_id: 'op-cover-enrich',
        entity_type: 'card',
        source_id: CARD_SOURCE,
        operation: 'enrich',
        target_id: CARD_ID,
        dependencies: ['op-card-link', 'op-attachment-create'],
        payload_ref: ENRICH_PAYLOAD,
        expected_target_fields: { ...EMPTY_COVER },
        expected_target_fingerprint: emptyCoverFingerprint(),
      }),
    ],
  };
}

const PAYLOADS: Record<string, unknown> = {
  [CARD_PAYLOAD]: {
    entity_type: 'card',
    source_id: CARD_SOURCE,
    historical_author: 'm_synth_alice',
    created_at: '2026-01-20T10:00:00.000Z',
    updated_at: '2026-01-20T10:00:00.000Z',
    fields: {
      list_id: SYNTH_LIST_ID,
      title: 'Cover chain card',
      description: 'card whose Trello cover came from an attachment',
      position: '0000000000000007.000000',
      archived: false,
    },
  },
  [ATT_PAYLOAD]: {
    entity_type: 'attachment',
    source_id: ATT_SOURCE,
    historical_author: 'm_synth_bob',
    created_at: '2026-01-20T10:05:00.000Z',
    fields: {
      card_id: CARD_ID,
      name: 'cover.png',
      type: 'FILE',
      s3_key: 'imports/cover.png',
      s3_bucket: 'chimedeck',
      mime_type: 'image/png',
      size_bytes: 1024,
      status: 'READY',
    },
  },
  [ENRICH_PAYLOAD]: {
    entity_type: 'card',
    source_id: CARD_SOURCE,
    fields: { cover_attachment_id: ATT_ID, cover_color: null, cover_size: 'FULL' },
  },
};

function freshDeps(payloads: Record<string, unknown> = PAYLOADS): MemoryImporterDeps {
  return new MemoryImporterDeps(SYNTH_IDENTITY_MAP, payloads);
}

function nativeCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CARD_ID,
    short_id: 'Crdcov01',
    list_id: SYNTH_LIST_ID,
    title: 'Cover chain card',
    description: 'card whose Trello cover came from an attachment',
    position: '0000000000000007.000000',
    archived: false,
    due_date: null,
    due_complete: false,
    start_date: null,
    ...EMPTY_COVER,
    ...overrides,
  };
}

async function gatesFor(
  plan: ImportPlan,
  deps: MemoryImporterDeps,
  expectations?: { expectedSnapshotHash?: string | null }
): Promise<ApplyGates> {
  const validation = await validatePlan(plan, deps, OPERATOR, expectations);
  expect(validation.ok).toBe(true);
  return {
    applyEnabled: true,
    confirmedPlanHash: validation.plan_hash,
    confirmedDestinationFingerprint: (await observeDestination(plan, deps)).fingerprint,
    expectations,
  };
}

function codes(plan: ImportPlan, deps: MemoryImporterDeps) {
  return validatePlan(plan, deps, OPERATOR).then((v) => v.errors.map((e) => e.code));
}

describe('cover chain — create then cover enrich on the same source identity', () => {
  it('materialises the card, its import-owned cover attachment and the cover in one plan', async () => {
    const deps = freshDeps();
    const plan = createChainPlan();

    const result = await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.operations_applied).toBe(3);
    expect(result.operations_blocked).toBe(0);
    expect(result.operations_failed).toBe(0);
    expect(deps.rows.get(`card:${CARD_ID}`)).toMatchObject({
      cover_attachment_id: ATT_ID,
      cover_color: null,
      cover_size: 'FULL',
    });
    // one provenance claim per source identity — the card keeps exactly one
    const cardClaims = deps.provenance.filter(
      (p) => p.entity_type === 'card' && p.source_id === CARD_SOURCE
    );
    expect(cardClaims).toHaveLength(1);
    expect(cardClaims[0]).toMatchObject({ target_id: CARD_ID, operation: 'create' });
    expect(
      deps.provenance.filter((p) => p.entity_type === 'attachment' && p.source_id === ATT_SOURCE)
    ).toHaveLength(1);
    // suppression invariant: no domain events were dispatched
    expect(deps.dispatchedDomainEvents).toEqual([]);
  });

  it('rehearses the chain write-free and reruns as a no-op', async () => {
    const deps = freshDeps();
    const plan = createChainPlan();
    const rowsBefore = deps.rows.size;

    const dry = await dryRunPlan(plan, deps, OPERATOR);
    expect(dry.operations_applied).toBe(3);
    expect(dry.operations_blocked).toBe(0);
    expect(dry.operations_failed).toBe(0);
    // the rehearsal kept nothing: no card row, no provenance
    expect(deps.rows.size).toBe(rowsBefore);
    expect(deps.rows.has(`card:${CARD_ID}`)).toBe(false);
    expect(deps.provenance).toHaveLength(0);

    const first = await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR);
    expect('error' in first).toBe(false);
    if ('error' in first) return;
    expect(first.operations_applied).toBe(3);
    const cover = { ...(deps.rows.get(`card:${CARD_ID}`) as Record<string, unknown>) };

    const second = await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR);
    expect('error' in second).toBe(false);
    if ('error' in second) return;
    expect(second.operations_applied).toBe(0);
    expect(second.operations_noop).toBe(3);
    expect(deps.rows.get(`card:${CARD_ID}`)).toEqual(cover);
    expect(
      deps.provenance.filter((p) => p.entity_type === 'card' && p.source_id === CARD_SOURCE)
    ).toHaveLength(1);
  });

  it('links a provenance-free existing card and enriches its cover (link chain)', async () => {
    const deps = freshDeps();
    const native = nativeCard();
    deps.rows.set(`card:${CARD_ID}`, native);
    const plan = linkChainPlan(native);

    const result = await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.operations_applied).toBe(3);
    const cardClaims = deps.provenance.filter(
      (p) => p.entity_type === 'card' && p.source_id === CARD_SOURCE
    );
    expect(cardClaims).toHaveLength(1);
    expect(cardClaims[0]).toMatchObject({ target_id: CARD_ID, operation: 'link' });
    expect(deps.rows.get(`card:${CARD_ID}`)).toMatchObject({
      cover_attachment_id: ATT_ID,
      cover_size: 'FULL',
    });
  });

  it('preserves a native cover on a linked card instead of overwriting it (drift)', async () => {
    const deps = freshDeps();
    const native = nativeCard({ cover_color: '#123456', cover_size: 'FULL' });
    deps.rows.set(`card:${CARD_ID}`, native);
    const plan = linkChainPlan(nativeCard());

    const result = await applyPlan(plan, await gatesFor(plan, deps), deps, OPERATOR);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    const coverOutcome = result.outcomes.find((o) => o.op_id === 'op-cover-enrich')!;
    expect(coverOutcome.status).toBe('blocked');
    expect(deps.rows.get(`card:${CARD_ID}`)).toMatchObject({
      cover_color: '#123456',
      cover_size: 'FULL',
      cover_attachment_id: null,
    });
  });

  it('never relaxes the duplicate-source rule outside the constrained chain', async () => {
    // two creates for one source identity
    const d1 = freshDeps();
    const twoCreates = createChainPlan();
    twoCreates.operations[2] = op({
      ...twoCreates.operations[2]!,
      operation: 'create',
      dependencies: ['op-card-create'],
    });
    expect(await codes(twoCreates, d1)).toContain('duplicate-source');

    // same source, different target
    const d2 = freshDeps();
    const otherTarget = createChainPlan();
    otherTarget.operations[2] = { ...otherTarget.operations[2]!, target_id: 'crd_somewhere_else' };
    expect(await codes(otherTarget, d2)).toContain('duplicate-source');

    // enrich before the materialisation (wrong order)
    const d3 = freshDeps();
    const wrongOrder = createChainPlan();
    wrongOrder.operations = [
      wrongOrder.operations[2]!,
      wrongOrder.operations[0]!,
      wrongOrder.operations[1]!,
    ];
    expect(await codes(wrongOrder, d3)).toContain('duplicate-source');

    // a third operation claiming the same source identity
    const d4 = freshDeps();
    const triple = createChainPlan();
    triple.operations.push(
      op({
        ...triple.operations[2]!,
        op_id: 'op-cover-enrich-2',
        dependencies: ['op-card-create', 'op-attachment-create', 'op-cover-enrich'],
      })
    );
    expect(await codes(triple, d4)).toContain('duplicate-source');

    // a non-card duplicate source
    const d5 = freshDeps();
    const nonCard = createChainPlan();
    nonCard.operations.push(
      op({
        op_id: 'op-attachment-create-2',
        entity_type: 'attachment',
        source_id: ATT_SOURCE,
        operation: 'create',
        target_id: 'att_cover_chain_other',
        dependencies: ['op-card-create'],
        payload_ref: ATT_PAYLOAD,
      })
    );
    expect(await codes(nonCard, d5)).toContain('duplicate-source');
  });

  it('requires the enrich to depend directly on the card materialisation and its cover attachment', async () => {
    // no direct dependency on the card create
    const d1 = freshDeps();
    const noMaterialisationDep = createChainPlan();
    noMaterialisationDep.operations[2] = {
      ...noMaterialisationDep.operations[2]!,
      dependencies: ['op-attachment-create'],
    };
    expect(await codes(noMaterialisationDep, d1)).toContain('enrich-chain-dependency-missing');

    // no direct dependency on the import-owned attachment
    const d2 = freshDeps();
    const noAttachmentDep = createChainPlan();
    noAttachmentDep.operations[2] = {
      ...noAttachmentDep.operations[2]!,
      dependencies: ['op-card-create'],
    };
    expect(await codes(noAttachmentDep, d2)).toContain('enrich-chain-attachment-missing');

    // the attachment is not planned against the same card
    const d3 = freshDeps();
    const foreignAttachment = createChainPlan();
    foreignAttachment.operations[1] = {
      ...foreignAttachment.operations[1]!,
      dependencies: [],
    };
    expect(await codes(foreignAttachment, d3)).toContain('enrich-chain-attachment-missing');

    // a dependency that is not an attachment op at all
    const d4 = freshDeps();
    const wrongDepKind = createChainPlan();
    wrongDepKind.operations.push(
      op({
        op_id: 'op-list-create',
        entity_type: 'list',
        source_id: 'trello_list_cover_chain_0001',
        operation: 'create',
        target_id: 'lst_cover_chain_0001',
        dependencies: ['op-card-create'],
      })
    );
    wrongDepKind.operations[2] = {
      ...wrongDepKind.operations[2]!,
      dependencies: ['op-card-create', 'op-list-create'],
    };
    expect(await codes(wrongDepKind, d4)).toContain('enrich-chain-attachment-missing');
  });

  it('rejects an enrich pre-image that is not an exactly empty native cover', async () => {
    const deps = freshDeps();
    const plan = createChainPlan();
    const nonEmpty = { cover_attachment_id: null, cover_color: '#1D4ED8', cover_size: 'FULL' };
    plan.operations[2] = {
      ...plan.operations[2]!,
      expected_target_fields: nonEmpty,
      expected_target_fingerprint: fingerprintFields(nonEmpty, CARD_COVER_FIELDS),
    };
    expect(await codes(plan, deps)).toContain('enrich-preimage-not-empty');
  });
});
