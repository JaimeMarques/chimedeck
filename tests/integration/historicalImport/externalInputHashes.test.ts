import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyPlan,
  dryRunPlan,
  validatePlan,
  type ImportPlan,
} from '../../../server/extensions/historicalImport/core/plan';
import {
  canonicalJson,
  sha256Hex,
} from '../../../server/extensions/historicalImport/core/fingerprint';
import { MemoryImporterDeps } from './harness';
import { SYNTH_IDENTITY_MAP, syntheticPlan } from './fixtures';

const OPERATOR = 'usr_operator_0001';
const HASH = 'a'.repeat(64);
const envKeys = [
  'HISTORICAL_IMPORT_PAYLOAD_ROOT',
  'HISTORICAL_IMPORT_PAYLOAD_MANIFEST',
  'HISTORICAL_IMPORT_IDENTITY_MAP',
  'HISTORICAL_IMPORT_ATTACHMENT_OBJECT_MANIFEST',
  'HISTORICAL_IMPORT_DESTINATION_ROW_SOURCE',
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, Bun.env[key]]));
const tempRoots: string[] = [];

interface PinnedPlan extends ImportPlan {
  input_preconditions: {
    payload_manifest: { canonical_sha256: string };
    identity_map: { importer_map_sha256: string };
    attachment_object_manifest: { canonical_sha256: string };
    destination_row_source: { rows_sha256: string };
  };
}

function digest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function manifest(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, manifest_sha256: digest(body) };
}

function rowSource(rows: Record<string, unknown> = {}): Record<string, unknown> {
  const body = {
    entity_tables: {},
    columns: {},
    census: {},
    drift_sensitive_columns: {},
    skipped_no_id_column: [],
    rows,
  };
  return { schema_version: 1, ...body, rows_sha256: digest(body) };
}

async function stageInputs(): Promise<{
  plan: PinnedPlan;
  paths: Record<string, string>;
  docs: Record<string, Record<string, unknown>>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'historical-import-inputs-'));
  tempRoots.push(root);
  const plan = syntheticPlan() as PinnedPlan;
  plan.plan_id = 'plan_external_input_hashes';

  const payloadBody = {
    schema_version: 1,
    staging_root: '/payloads/plan_synth_0001',
    payloads: plan.operations
      .filter((op) => op.payload_ref !== null)
      .map((op) => ({ op_id: op.op_id, payload_ref: op.payload_ref, sha256: HASH })),
  };
  const docs = {
    payload_manifest: manifest(payloadBody),
    identity_map: { ...SYNTH_IDENTITY_MAP },
    attachment_object_manifest: manifest({
      schema_version: 1,
      policy: { sha256_readback_required: true },
      operations: [],
    }),
    destination_row_source: rowSource(),
  };
  const paths = {
    payload_manifest: join(root, 'payload-manifest.json'),
    identity_map: join(root, 'identity-map.json'),
    attachment_object_manifest: join(root, 'attachment-object-manifest.json'),
    destination_row_source: join(root, 'destination-db-rows.json'),
  };
  await Promise.all(
    Object.entries(paths).map(([key, path]) => writeFile(path, JSON.stringify(docs[key]!)))
  );

  Bun.env['HISTORICAL_IMPORT_PAYLOAD_ROOT'] = '/payloads/plan_synth_0001';
  Bun.env['HISTORICAL_IMPORT_PAYLOAD_MANIFEST'] = paths.payload_manifest;
  Bun.env['HISTORICAL_IMPORT_IDENTITY_MAP'] = paths.identity_map;
  Bun.env['HISTORICAL_IMPORT_ATTACHMENT_OBJECT_MANIFEST'] = paths.attachment_object_manifest;
  Bun.env['HISTORICAL_IMPORT_DESTINATION_ROW_SOURCE'] = paths.destination_row_source;

  plan.input_preconditions = {
    payload_manifest: { canonical_sha256: digest(payloadBody) },
    identity_map: { importer_map_sha256: digest(docs.identity_map) },
    attachment_object_manifest: {
      canonical_sha256: digest(
        Object.fromEntries(
          Object.entries(docs.attachment_object_manifest).filter(
            ([key]) => key !== 'manifest_sha256'
          )
        )
      ),
    },
    destination_row_source: {
      rows_sha256: String(docs.destination_row_source.rows_sha256),
    },
  };
  return { plan, paths, docs };
}

afterEach(async () => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('plan-pinned external input hashes', () => {
  it('accepts the exact payload manifest, identity map, object manifest and row source', async () => {
    const { plan } = await stageInputs();
    const validation = await validatePlan(
      plan,
      new MemoryImporterDeps(SYNTH_IDENTITY_MAP),
      OPERATOR
    );

    expect(validation.ok).toBe(true);
    expect(validation.external_input_hashes_verified).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('rejects a changed payload manifest even when its own self-hash is regenerated', async () => {
    const { plan, paths, docs } = await stageInputs();
    const changedBody = {
      ...(docs.payload_manifest as Record<string, unknown>),
      payloads: [],
    };
    delete changedBody.manifest_sha256;
    await writeFile(paths.payload_manifest, JSON.stringify(manifest(changedBody)));

    const validation = await validatePlan(
      plan,
      new MemoryImporterDeps(SYNTH_IDENTITY_MAP),
      OPERATOR
    );

    expect(validation.ok).toBe(false);
    expect(validation.errors.some((error) => error.code === 'external-input-hash-mismatch')).toBe(
      true
    );
  });

  it('fails closed on a swapped identity map for validate, dry-run and apply before writes', async () => {
    const { plan, paths } = await stageInputs();
    const deps = new MemoryImporterDeps(SYNTH_IDENTITY_MAP);
    const confirmed = await validatePlan(plan, deps, OPERATOR);
    expect(confirmed.ok).toBe(true);
    const rowsBefore = structuredClone([...deps.rows.entries()]);

    await writeFile(paths.identity_map, JSON.stringify({ m_synth_alice: 'usr_attacker' }));
    const validation = await validatePlan(plan, deps, OPERATOR);
    const dryRun = (await dryRunPlan(plan, deps, OPERATOR)) as {
      validation_errors?: Array<{ code: string }>;
      operations_applied: number;
    };
    const apply = await applyPlan(
      plan,
      {
        applyEnabled: true,
        confirmedPlanHash: confirmed.plan_hash,
        confirmedDestinationFingerprint: confirmed.destination_fingerprint,
      },
      deps,
      OPERATOR
    );

    expect(validation.errors.map((error) => error.code)).toContain('external-input-hash-mismatch');
    expect(dryRun.validation_errors?.map((error) => error.code)).toContain(
      'external-input-hash-mismatch'
    );
    expect(dryRun.operations_applied).toBe(0);
    expect('error' in apply && apply.code).toBe('external-input-divergence');
    expect([...deps.rows.entries()]).toEqual(rowsBefore);
    expect(deps.provenance).toHaveLength(0);
  });

  it('rejects missing, unreadable and malformed referenced inputs', async () => {
    const { plan, paths } = await stageInputs();
    delete Bun.env['HISTORICAL_IMPORT_DESTINATION_ROW_SOURCE'];
    let validation = await validatePlan(plan, new MemoryImporterDeps(SYNTH_IDENTITY_MAP), OPERATOR);
    expect(validation.errors.some((error) => error.code === 'external-input-unconfigured')).toBe(
      true
    );

    Bun.env['HISTORICAL_IMPORT_DESTINATION_ROW_SOURCE'] = join(
      paths.destination_row_source,
      'missing'
    );
    validation = await validatePlan(plan, new MemoryImporterDeps(SYNTH_IDENTITY_MAP), OPERATOR);
    expect(validation.errors.some((error) => error.code === 'external-input-unreadable')).toBe(
      true
    );

    Bun.env['HISTORICAL_IMPORT_DESTINATION_ROW_SOURCE'] = paths.destination_row_source;
    await writeFile(paths.destination_row_source, '{not-json');
    validation = await validatePlan(plan, new MemoryImporterDeps(SYNTH_IDENTITY_MAP), OPERATOR);
    expect(validation.errors.some((error) => error.code === 'external-input-invalid')).toBe(true);
  });

  it('rejects changed attachment-object and row-source manifests independently', async () => {
    const { plan, paths, docs } = await stageInputs();
    await writeFile(
      paths.attachment_object_manifest,
      JSON.stringify(manifest({ schema_version: 1, policy: {}, operations: [{ swapped: true }] }))
    );
    let validation = await validatePlan(plan, new MemoryImporterDeps(SYNTH_IDENTITY_MAP), OPERATOR);
    expect(validation.errors.some((error) => error.code === 'external-input-hash-mismatch')).toBe(
      true
    );

    await writeFile(
      paths.attachment_object_manifest,
      JSON.stringify(docs.attachment_object_manifest)
    );
    await writeFile(
      paths.destination_row_source,
      JSON.stringify(rowSource({ card: { swapped: {} } }))
    );
    validation = await validatePlan(plan, new MemoryImporterDeps(SYNTH_IDENTITY_MAP), OPERATOR);
    expect(validation.errors.some((error) => error.code === 'external-input-hash-mismatch')).toBe(
      true
    );
  });
});
