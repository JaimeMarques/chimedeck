import { readFile } from 'node:fs/promises';
import { canonicalJson, sha256Hex } from './fingerprint';
import { reloadPayloadManifest } from './payload';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type ExternalInputName =
  | 'payload_manifest'
  | 'identity_map'
  | 'attachment_object_manifest'
  | 'destination_row_source';

export interface ExternalInputIssue {
  op_id: 'plan';
  code:
    | 'external-input-pin-invalid'
    | 'external-input-unconfigured'
    | 'external-input-unreadable'
    | 'external-input-invalid'
    | 'external-input-hash-mismatch';
  message: string;
}

interface InputPreconditions {
  payload_manifest?: { canonical_sha256?: unknown };
  identity_map?: { importer_map_sha256?: unknown };
  attachment_object_manifest?: {
    canonical_sha256?: unknown;
    operations?: unknown;
    bytes?: unknown;
  };
  destination_row_source?: { rows_sha256?: unknown };
}

interface PlanWithInputs {
  input_preconditions?: InputPreconditions;
  operations?: Array<{ op_id?: unknown; payload_ref?: unknown }>;
}

const ENV_BY_INPUT: Record<ExternalInputName, string> = {
  payload_manifest: 'HISTORICAL_IMPORT_PAYLOAD_MANIFEST',
  identity_map: 'HISTORICAL_IMPORT_IDENTITY_MAP',
  attachment_object_manifest: 'HISTORICAL_IMPORT_ATTACHMENT_OBJECT_MANIFEST',
  destination_row_source: 'HISTORICAL_IMPORT_DESTINATION_ROW_SOURCE',
};

function digest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function withoutField(document: Record<string, unknown>, field: string): Record<string, unknown> {
  const body = { ...document };
  delete body[field];
  return body;
}

function issue(code: ExternalInputIssue['code'], message: string): ExternalInputIssue {
  return { op_id: 'plan', code, message };
}

async function readJsonInput(name: ExternalInputName): Promise<Record<string, unknown>> {
  const path = Bun.env[ENV_BY_INPUT[name]] ?? '';
  if (!path) {
    throw Object.assign(
      new Error(`${name} is referenced by the plan but its server path is not configured`),
      {
        externalInputCode: 'external-input-unconfigured',
      }
    );
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw Object.assign(new Error(`${name} is referenced by the plan but cannot be read`), {
      externalInputCode: 'external-input-unreadable',
    });
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error(`${name} is not a valid JSON object`), {
      externalInputCode: 'external-input-invalid',
    });
  }
}

function expectedHash(name: ExternalInputName, pin: unknown): string | null {
  const candidate =
    name === 'identity_map'
      ? (pin as { importer_map_sha256?: unknown })?.importer_map_sha256
      : name === 'destination_row_source'
        ? (pin as { rows_sha256?: unknown })?.rows_sha256
        : (pin as { canonical_sha256?: unknown })?.canonical_sha256;
  return typeof candidate === 'string' && HASH_PATTERN.test(candidate) ? candidate : null;
}

function rowSourceDigest(document: Record<string, unknown>): string | null {
  const keys = [
    'entity_tables',
    'columns',
    'census',
    'drift_sensitive_columns',
    'skipped_no_id_column',
    'rows',
  ] as const;
  if (keys.some((key) => !(key in document))) return null;
  return digest(Object.fromEntries(keys.map((key) => [key, document[key]])));
}

function validatePayloadManifest(
  plan: PlanWithInputs,
  document: Record<string, unknown>,
  errors: ExternalInputIssue[]
): void {
  const body = withoutField(document, 'manifest_sha256');
  const selfHash = document.manifest_sha256;
  if (typeof selfHash !== 'string' || !HASH_PATTERN.test(selfHash) || selfHash !== digest(body)) {
    errors.push(
      issue('external-input-invalid', 'payload_manifest manifest_sha256 is missing or inconsistent')
    );
  }

  const configuredRoot = Bun.env['HISTORICAL_IMPORT_PAYLOAD_ROOT'] ?? '';
  if (!configuredRoot || document.staging_root !== configuredRoot) {
    errors.push(
      issue(
        'external-input-invalid',
        'payload_manifest staging_root does not equal HISTORICAL_IMPORT_PAYLOAD_ROOT'
      )
    );
  }

  const entries = Array.isArray(document.payloads)
    ? (document.payloads as Array<Record<string, unknown>>)
    : null;
  if (!entries) return;
  const byRef = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.payload_ref !== 'string' ||
      typeof entry.op_id !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      !HASH_PATTERN.test(entry.sha256) ||
      byRef.has(entry.payload_ref)
    ) {
      errors.push(
        issue('external-input-invalid', 'payload_manifest contains a malformed or duplicate entry')
      );
      return;
    }
    byRef.set(entry.payload_ref, entry);
  }
  for (const operation of plan.operations ?? []) {
    if (typeof operation.payload_ref !== 'string') continue;
    const entry = byRef.get(operation.payload_ref);
    if (!entry || entry.op_id !== operation.op_id) {
      errors.push(
        issue(
          'external-input-invalid',
          `payload_manifest does not bind ${String(operation.op_id)} to its exact payload_ref`
        )
      );
      return;
    }
  }
}

function validateIdentityMap(
  document: Record<string, unknown>,
  errors: ExternalInputIssue[]
): void {
  if (Object.values(document).some((value) => typeof value !== 'string' || value.length === 0)) {
    errors.push(
      issue('external-input-invalid', 'identity_map must map source ids to non-empty user ids')
    );
  }
}

function validateAttachmentManifest(
  pin: InputPreconditions['attachment_object_manifest'],
  document: Record<string, unknown>,
  errors: ExternalInputIssue[]
): void {
  const body = withoutField(document, 'manifest_sha256');
  const selfHash = document.manifest_sha256;
  if (typeof selfHash !== 'string' || !HASH_PATTERN.test(selfHash) || selfHash !== digest(body)) {
    errors.push(
      issue(
        'external-input-invalid',
        'attachment_object_manifest manifest_sha256 is missing or inconsistent'
      )
    );
  }
  if (!Array.isArray(document.operations)) {
    errors.push(
      issue('external-input-invalid', 'attachment_object_manifest has no operations[] array')
    );
    return;
  }
  if (typeof pin?.operations === 'number' && document.operations.length !== pin.operations) {
    errors.push(
      issue(
        'external-input-invalid',
        'attachment_object_manifest operation count differs from the plan'
      )
    );
  }
  if (typeof pin?.bytes === 'number') {
    const bytes = document.operations.reduce(
      (total, operation) =>
        total +
        (typeof operation === 'object' &&
        operation !== null &&
        typeof (operation as Record<string, unknown>).expected_bytes === 'number'
          ? ((operation as Record<string, unknown>).expected_bytes as number)
          : 0),
      0
    );
    if (bytes !== pin.bytes) {
      errors.push(
        issue(
          'external-input-invalid',
          'attachment_object_manifest byte count differs from the plan'
        )
      );
    }
  }
}

export async function verifyExternalInputHashes(
  plan: PlanWithInputs,
  loadedExternalInputHash?: (name: 'identity_map') => Promise<string | null>
): Promise<{
  referenced: number;
  verified: boolean;
  errors: ExternalInputIssue[];
}> {
  const pins = plan.input_preconditions;
  const errors: ExternalInputIssue[] = [];
  if (!pins || typeof pins !== 'object') return { referenced: 0, verified: false, errors };

  const candidates: Array<readonly [ExternalInputName, unknown]> = [
    ['payload_manifest', pins.payload_manifest],
    ['identity_map', pins.identity_map],
    ['attachment_object_manifest', pins.attachment_object_manifest],
    ['destination_row_source', pins.destination_row_source],
  ];
  const entries = candidates.filter(([, pin]) => pin !== undefined && pin !== null);

  for (const [name, pin] of entries) {
    const expected = expectedHash(name, pin);
    if (!expected) {
      errors.push(issue('external-input-pin-invalid', `${name} has no valid frozen SHA-256 pin`));
      continue;
    }
    if (!(Bun.env[ENV_BY_INPUT[name]] ?? '')) {
      errors.push(
        issue(
          'external-input-unconfigured',
          `${name} is referenced by the plan but ${ENV_BY_INPUT[name]} is not configured`
        )
      );
      continue;
    }

    try {
      const document =
        name === 'payload_manifest'
          ? (await reloadPayloadManifest()).document
          : await readJsonInput(name);
      let actual: string | null;
      if (name === 'payload_manifest' || name === 'attachment_object_manifest') {
        actual = digest(withoutField(document, 'manifest_sha256'));
      } else if (name === 'destination_row_source') {
        actual = rowSourceDigest(document);
        if (!actual) {
          errors.push(
            issue(
              'external-input-invalid',
              'destination_row_source is missing hash-bound row fields'
            )
          );
          continue;
        }
        if (document.rows_sha256 !== actual) {
          errors.push(
            issue('external-input-invalid', 'destination_row_source rows_sha256 is inconsistent')
          );
        }
      } else {
        actual = digest(document);
      }

      if (actual !== expected) {
        errors.push(
          issue(
            'external-input-hash-mismatch',
            `${name} diverges from the plan pin: expected ${expected.slice(0, 12)}…, found ${actual.slice(0, 12)}…`
          )
        );
      }
      if (name === 'identity_map' && loadedExternalInputHash) {
        const loadedHash = await loadedExternalInputHash('identity_map');
        if (!loadedHash || loadedHash !== expected) {
          errors.push(
            issue(
              'external-input-hash-mismatch',
              loadedHash
                ? `identity_map loaded for execution diverges from the plan pin: expected ${expected.slice(0, 12)}…, found ${loadedHash.slice(0, 12)}…`
                : 'identity_map loaded for execution has no verifiable digest'
            )
          );
        }
      }
      if (name === 'payload_manifest') validatePayloadManifest(plan, document, errors);
      if (name === 'identity_map') validateIdentityMap(document, errors);
      if (name === 'attachment_object_manifest') {
        validateAttachmentManifest(pins.attachment_object_manifest, document, errors);
      }
    } catch (error: unknown) {
      const tagged = error as { externalInputCode?: ExternalInputIssue['code']; message?: string };
      const code = tagged.externalInputCode ?? 'external-input-invalid';
      errors.push(issue(code, tagged.message ?? `${name} could not be verified`));
    }
  }

  return {
    referenced: entries.length,
    verified: entries.length > 0 && errors.length === 0,
    errors,
  };
}
