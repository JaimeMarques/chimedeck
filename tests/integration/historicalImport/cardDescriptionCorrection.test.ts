import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyPlan,
  validatePlan,
  type ApplyGates,
  type ImportPlan,
} from '../../../server/extensions/historicalImport/core/plan';
import {
  canonicalJson,
  fingerprintFields,
  fingerprintJson,
  sha256Hex,
} from '../../../server/extensions/historicalImport/core/fingerprint';
import { MemoryImporterDeps } from './harness';

const OPERATOR = 'usr_operator_0001';
const SOURCE_ID = '6a7b2fa270a82a479e70e3a0';
const TARGET_ID = 'b80ad0ac-05e5-4350-81a1-b7aa1ea117be';
const PAYLOAD_REF = 'file:///payloads/phoenix/op-card-description.json';
const DECISION_SHA256 = 'bfe5135e63ad105668144df112bbe5fe0b5ae3ae4bae5429281230122b34a47a';
const AUTHORIZATION_ID = `card-description:${SOURCE_ID}:${TARGET_ID}`;
const SOURCE_DESCRIPTION = 'literal & text';
const TARGET_DESCRIPTION = 'literal &amp; text';
const DESCRIPTION_FIELDS = ['description'] as const;
const tempRoots: string[] = [];
const originalAuthorizationPath = Bun.env['HISTORICAL_IMPORT_CARD_DESCRIPTION_AUTHORIZATION'];

function digest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function targetRow(description = TARGET_DESCRIPTION): Record<string, unknown> {
  return {
    id: TARGET_ID,
    list_id: 'list-phoenix',
    title: 'Native title must survive',
    description,
    position: 'a0',
    archived: false,
    due_date: null,
    due_complete: false,
    start_date: null,
    short_id: 'Card0001',
    created_at: '2025-07-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    cover_attachment_id: null,
    cover_color: null,
    cover_size: 'SMALL',
  };
}

async function setup(): Promise<{
  deps: MemoryImporterDeps;
  plan: ImportPlan;
  authorizationSha256: string;
}> {
  const sourceDescriptionSha256 = sha256Hex(SOURCE_DESCRIPTION);
  const targetDescriptionSha256 = sha256Hex(TARGET_DESCRIPTION);
  const authorizationBody = {
    schema_version: 1,
    category: 'card-description-raw-correction',
    decision_sha256: DECISION_SHA256,
    entries: [
      {
        authorization_id: AUTHORIZATION_ID,
        source_id: SOURCE_ID,
        target_id: TARGET_ID,
        source_description_sha256: sourceDescriptionSha256,
        target_description_sha256: targetDescriptionSha256,
      },
    ],
  };
  const authorizationSha256 = digest(authorizationBody);
  const root = await mkdtemp(join(tmpdir(), 'card-description-authorization-'));
  tempRoots.push(root);
  const authorizationPath = join(root, 'card-description-authorization.json');
  await writeFile(
    authorizationPath,
    JSON.stringify({ ...authorizationBody, manifest_sha256: authorizationSha256 })
  );
  Bun.env['HISTORICAL_IMPORT_CARD_DESCRIPTION_AUTHORIZATION'] = authorizationPath;

  const payload = {
    entity_type: 'card',
    source_id: SOURCE_ID,
    fields: { description: SOURCE_DESCRIPTION },
    card_description_correction: {
      authorization_id: AUTHORIZATION_ID,
      authorization_sha256: authorizationSha256,
      decision_sha256: DECISION_SHA256,
      target_id: TARGET_ID,
      source_description_sha256: sourceDescriptionSha256,
      target_description_sha256: targetDescriptionSha256,
    },
  };
  const deps = new MemoryImporterDeps({}, { [PAYLOAD_REF]: payload }, authorizationBody);
  const row = targetRow();
  deps.rows.set(`card:${TARGET_ID}`, row);
  const expectedFields = { description: TARGET_DESCRIPTION };
  const plan = {
    plan_id: 'plan_phoenix_card_description_correction',
    source_system: 'trello',
    snapshot_hash: 'a'.repeat(64),
    created_at: '2026-09-17T04:30:00.000Z',
    input_preconditions: {
      card_description_authorization: {
        canonical_sha256: authorizationSha256,
        decision_sha256: DECISION_SHA256,
      },
    },
    operations: [
      {
        op_id: 'op-correct-card-description',
        entity_type: 'card',
        source_id: SOURCE_ID,
        target_id: TARGET_ID,
        operation: 'correct_card_description',
        provenance: {
          source_system: 'trello',
          source_id: SOURCE_ID,
          evidence_refs: [`trello-export:cards/${SOURCE_ID}`],
          board_id: 'board-phoenix',
        },
        evidence_refs: [`trello-export:cards/${SOURCE_ID}`],
        expected_target_fields: expectedFields,
        expected_target_fingerprint: fingerprintFields(expectedFields, DESCRIPTION_FIELDS),
        expected_target_row_fingerprint: fingerprintJson(row),
        card_description_authorization: {
          authorization_id: AUTHORIZATION_ID,
          decision_sha256: DECISION_SHA256,
          source_description_sha256: sourceDescriptionSha256,
          target_description_sha256: targetDescriptionSha256,
        },
        payload_ref: PAYLOAD_REF,
        dependencies: [],
      },
    ],
  } as unknown as ImportPlan;
  return { deps, plan, authorizationSha256 };
}

async function gates(plan: ImportPlan, deps: MemoryImporterDeps): Promise<ApplyGates> {
  const validation = await validatePlan(plan, deps, OPERATOR);
  expect(validation.errors).toEqual([]);
  expect(validation.ok).toBe(true);
  return {
    applyEnabled: true,
    confirmedPlanHash: validation.plan_hash,
    confirmedDestinationFingerprint: validation.destination_fingerprint,
  };
}

afterEach(async () => {
  if (originalAuthorizationPath === undefined) {
    delete Bun.env['HISTORICAL_IMPORT_CARD_DESCRIPTION_AUTHORIZATION'];
  } else {
    Bun.env['HISTORICAL_IMPORT_CARD_DESCRIPTION_AUTHORIZATION'] = originalAuthorizationPath;
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('raw id-bounded card description correction', () => {
  it('changes only cards.description and records provenance for an artifact-authorized pair', async () => {
    const { deps, plan } = await setup();
    const before = structuredClone(deps.rows.get(`card:${TARGET_ID}`));

    const result = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.operations_applied).toBe(1);
    expect(deps.rows.get(`card:${TARGET_ID}`)).toEqual({
      ...before,
      description: SOURCE_DESCRIPTION,
    });
    expect(deps.provenance).toHaveLength(1);
    expect(deps.provenance[0]).toMatchObject({
      source_system: 'trello',
      entity_type: 'card',
      source_id: SOURCE_ID,
      target_id: TARGET_ID,
      operation: 'correct_card_description',
    });
    expect(deps.dispatchedDomainEvents).toEqual([]);
  });

  it('makes an exact successful rerun a no-op', async () => {
    const { deps, plan } = await setup();
    const first = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);
    expect('error' in first).toBe(false);

    const second = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);

    expect('error' in second).toBe(false);
    if ('error' in second) return;
    expect(second.operations_applied).toBe(0);
    expect(second.operations_noop).toBe(1);
    expect(deps.provenance).toHaveLength(1);
    expect(deps.rows.get(`card:${TARGET_ID}`)?.description).toBe(SOURCE_DESCRIPTION);
  });

  it('rejects a pair absent from the immutable authorization allowlist during validation', async () => {
    const { deps, plan } = await setup();
    const operation = plan.operations[0]!;
    operation.source_id = 'unapproved-source';
    operation.provenance.source_id = 'unapproved-source';

    const validation = await validatePlan(plan, deps, OPERATOR);

    expect(validation.ok).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain(
      'card-description-pair-unauthorized'
    );
    expect(deps.rows.get(`card:${TARGET_ID}`)?.description).toBe(TARGET_DESCRIPTION);
    expect(deps.provenance).toHaveLength(0);
  });

  it('rejects any mutation field in addition to description', async () => {
    const { deps, plan } = await setup();
    const operation = plan.operations[0]!;
    operation.expected_target_fields = {
      description: TARGET_DESCRIPTION,
      title: 'Native title must survive',
    };

    const validation = await validatePlan(plan, deps, OPERATOR);

    expect(validation.ok).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain(
      'mutation-expected-fields-invalid'
    );
  });

  it('fails with zero mutation when staged source bytes do not match their raw SHA-256', async () => {
    const { deps, plan } = await setup();
    const payload = deps.payloadStore.get(PAYLOAD_REF)!;
    payload.card_description_correction!.source_description_sha256 = 'c'.repeat(64);
    const before = structuredClone(deps.rows.get(`card:${TARGET_ID}`));

    const result = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.operations_failed).toBe(1);
    expect(result.outcomes[0]?.status).toBe('failed');
    expect(result.outcomes[0]).toMatchObject({
      reason: 'card description correction source raw SHA-256 mismatch',
    });
    expect(deps.rows.get(`card:${TARGET_ID}`)).toEqual(before);
    expect(deps.provenance).toHaveLength(0);
  });

  it('fails with zero mutation when target entity decoding is not the exact source bytes', async () => {
    const { deps, plan } = await setup();
    const payload = deps.payloadStore.get(PAYLOAD_REF)!;
    payload.fields.description = 'not the decoded target';
    payload.card_description_correction!.source_description_sha256 = sha256Hex(
      String(payload.fields.description)
    );
    const before = structuredClone(deps.rows.get(`card:${TARGET_ID}`));

    const result = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.operations_failed).toBe(1);
    expect(result.outcomes[0]).toMatchObject({
      status: 'failed',
      reason: 'card description correction raw/entity-decoded descriptions do not match exactly',
    });
    expect(deps.rows.get(`card:${TARGET_ID}`)).toEqual(before);
    expect(deps.provenance).toHaveLength(0);
  });

  it('blocks stale target preimage and full-row fingerprints without partial mutation', async () => {
    const { deps, plan } = await setup();
    deps.rows.set(`card:${TARGET_ID}`, {
      ...deps.rows.get(`card:${TARGET_ID}`)!,
      description: 'later native description',
      title: 'later native title',
    });
    const before = structuredClone(deps.rows.get(`card:${TARGET_ID}`));

    const result = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.operations_blocked).toBe(1);
    expect(deps.rows.get(`card:${TARGET_ID}`)).toEqual(before);
    expect(deps.provenance).toHaveLength(0);
  });

  it('blocks a source already claimed by another target', async () => {
    const { deps, plan } = await setup();
    deps.provenance.push({
      id: 'prov-other-target',
      source_system: 'trello',
      entity_type: 'card',
      source_id: SOURCE_ID,
      target_id: 'another-target',
      target_ref: 'card:another-target',
      import_plan_hash: 'other-plan',
      operation: 'link',
    });
    const before = structuredClone(deps.rows.get(`card:${TARGET_ID}`));

    const result = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.operations_blocked).toBe(1);
    expect(deps.rows.get(`card:${TARGET_ID}`)).toEqual(before);
    expect(deps.provenance).toHaveLength(1);
  });

  it('blocks a target claim from another source system even when the source id text matches', async () => {
    const { deps, plan } = await setup();
    deps.provenance.push({
      id: 'prov-other-system',
      source_system: 'other',
      entity_type: 'card',
      source_id: SOURCE_ID,
      target_id: TARGET_ID,
      target_ref: `card:${TARGET_ID}`,
      import_plan_hash: 'other-plan',
      operation: 'link',
    });
    const before = structuredClone(deps.rows.get(`card:${TARGET_ID}`));

    const result = await applyPlan(plan, await gates(plan, deps), deps, OPERATOR);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.operations_blocked).toBe(1);
    expect(deps.rows.get(`card:${TARGET_ID}`)).toEqual(before);
    expect(deps.provenance).toHaveLength(1);
  });

  it('blocks a row that changes after the apply gates are confirmed', async () => {
    const { deps, plan } = await setup();
    const confirmedGates = await gates(plan, deps);
    const before = structuredClone(deps.rows.get(`card:${TARGET_ID}`));
    deps.concurrencyOverwrite = 'row-drift' as typeof deps.concurrencyOverwrite;

    const result = await applyPlan(plan, confirmedGates, deps, OPERATOR);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.operations_blocked).toBe(1);
    expect(deps.rows.get(`card:${TARGET_ID}`)).toEqual({
      ...before,
      title: 'concurrent native edit',
    });
    expect(deps.provenance).toHaveLength(0);
  });
});
