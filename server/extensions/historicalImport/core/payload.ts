// server/extensions/historicalImport/core/payload.ts
// Staged payload resolution + integrity verification.
//
// [why] payload_ref is a PRIVATE locator (e.g.
// "file:///var/lib/chimedeck/import-payloads/<plan>/<op>.json"). Payloads are
// staged on the server host by the operator and are never transported through
// the API, so they stay out of logs, proxies and the tool transport entirely.
//
// Two independent safety properties live here:
//  - path containment: a payload_ref may only resolve inside the configured
//    staging root (no arbitrary filesystem reads);
//  - content integrity: when HISTORICAL_IMPORT_PAYLOAD_MANIFEST is configured,
//    every staged payload must match the SHA-256 recorded for its exact
//    payload_ref in that manifest, so the bytes applied are the bytes reviewed.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Exported for compatibility with existing callers. Internal reads use the
// per-call helpers below so tests and long-running workers observe env changes.
export const PAYLOAD_STAGING_ROOT = Bun.env['HISTORICAL_IMPORT_PAYLOAD_ROOT'] ?? '';

// Path to the payload-manifest.json produced with the plan. This is mandatory
// whenever an operation uses payload_ref: without it the importer cannot prove
// that staged bytes equal the reviewed payload bytes, so both dry-run and apply
// fail closed rather than silently skipping integrity verification.
export const PAYLOAD_MANIFEST_PATH = Bun.env['HISTORICAL_IMPORT_PAYLOAD_MANIFEST'] ?? '';

function configuredPayloadRoot(): string {
  return Bun.env['HISTORICAL_IMPORT_PAYLOAD_ROOT'] ?? '';
}

function configuredManifestPath(): string {
  return Bun.env['HISTORICAL_IMPORT_PAYLOAD_MANIFEST'] ?? '';
}

// Payload staged-file shape. The staged file carries the historical author
// and timestamps; the API/manifest only carries the reference.
export interface StagedPayload {
  entity_type: string;
  source_id: string;
  historical_author?: string; // Trello member id
  created_at?: string; // ISO
  updated_at?: string; // ISO
  fields: Record<string, unknown>; // entity column => value
  object_precondition?: {
    bucket: string;
    key: string;
    byte_count: number;
    sha256: string;
  };
}

// Historical comments are preserved exactly as staged rather than passed through
// the normal user-input sanitizer. PostgreSQL TEXT stores every valid Unicode
// string without a length limit, but it cannot represent U+0000 or unpaired
// UTF-16 surrogates. Refuse only those unrepresentable values before opening a
// write transaction; never trim, normalize, escape, or otherwise alter content.
export function exactHistoricalCommentContent(fields: unknown): string {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('historical comment payload requires fields.content to be a string');
  }
  const content = (fields as Record<string, unknown>).content;
  if (typeof content !== 'string') {
    throw new Error('historical comment payload requires string content');
  }
  if (content.includes('\u0000')) {
    throw new Error(
      'historical comment content is not representable by PostgreSQL text: contains U+0000'
    );
  }
  for (let index = 0; index < content.length; index += 1) {
    const codeUnit = content.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      throw new Error(
        'historical comment content is not representable by PostgreSQL text: contains an unpaired UTF-16 surrogate'
      );
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(
        'historical comment content is not representable by PostgreSQL text: contains an unpaired UTF-16 surrogate'
      );
    }
  }
  return content;
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Read + hash a staged payload file, enforcing staging-root containment.
async function readStagedFile(payloadRef: string): Promise<{ path: string; bytes: Buffer }> {
  const configuredRoot = configuredPayloadRoot();
  if (!configuredRoot) {
    throw new Error('HISTORICAL_IMPORT_PAYLOAD_ROOT is not configured on the server');
  }
  // Only file: refs under the configured staging root are allowed — no
  // arbitrary filesystem reads.
  if (!payloadRef.startsWith('file://')) {
    throw new Error(`unsupported payload_ref scheme: ${payloadRef.split(':')[0]}`);
  }
  const rawPath = payloadRef.slice('file://'.length);
  const stagingRoot = resolve(configuredRoot);
  const absPath = resolve(rawPath);
  if (absPath !== stagingRoot && !absPath.startsWith(stagingRoot + sep)) {
    throw new Error('payload_ref escapes the configured staging root');
  }
  const bytes = await readFile(absPath);
  return { path: absPath, bytes };
}

export interface PayloadManifest {
  // payload_ref (exact, as declared in the plan) => sha256 of the staged file
  byRef: Map<string, string>;
  path: string;
  document: Record<string, unknown>;
}

let cachedManifest: PayloadManifest | null = null;

async function readPayloadManifest(): Promise<PayloadManifest> {
  const manifestPath = configuredManifestPath();
  if (!manifestPath) {
    throw new Error('HISTORICAL_IMPORT_PAYLOAD_MANIFEST is not configured on the server');
  }
  const text = await readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(text) as Record<string, unknown> & {
    payloads?: Array<{ payload_ref?: string; sha256?: string }>;
  };
  const entries = Array.isArray(parsed.payloads) ? parsed.payloads : null;
  if (!entries) {
    throw new Error(`payload manifest ${manifestPath} has no payloads[] array`);
  }
  const byRef = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry.payload_ref !== 'string' || !/^[0-9a-f]{64}$/.test(String(entry.sha256))) {
      throw new Error(`payload manifest ${manifestPath} has a malformed entry`);
    }
    if (byRef.has(entry.payload_ref)) {
      throw new Error(`payload manifest ${manifestPath} has a duplicate payload_ref`);
    }
    byRef.set(entry.payload_ref, entry.sha256 as string);
  }
  return { byRef, path: manifestPath, document: parsed };
}

// Load the manifest used by payload execution. Validation calls reload first,
// pinning this exact parsed document for the subsequent dry-run/apply body.
export async function loadPayloadManifest(): Promise<PayloadManifest> {
  const manifestPath = configuredManifestPath();
  if (cachedManifest?.path === manifestPath) return cachedManifest;
  cachedManifest = await readPayloadManifest();
  return cachedManifest;
}

export async function reloadPayloadManifest(): Promise<PayloadManifest> {
  cachedManifest = await readPayloadManifest();
  return cachedManifest;
}

// Test seam: drop the memoised manifest (env may change between tests).
export function resetPayloadManifestCache(): void {
  cachedManifest = null;
}

export async function resolveStagedPayload(
  payloadRef: string | null
): Promise<StagedPayload | null> {
  if (!payloadRef) return null;
  const { bytes } = await readStagedFile(payloadRef);
  return JSON.parse(bytes.toString('utf8')) as StagedPayload;
}

// Read a staged payload and verify it against the configured manifest.
// Throws (never returns a payload) when the reference is absent from the
// manifest or the bytes differ from the manifested SHA-256.
export async function readVerifiedStagedPayload(
  payloadRef: string | null
): Promise<StagedPayload | null> {
  if (!payloadRef) return null;
  const { bytes } = await readStagedFile(payloadRef);
  const manifest = await loadPayloadManifest();
  const expected = manifest.byRef.get(payloadRef);
  if (!expected) {
    throw new Error(`payload_ref is absent from the configured payload manifest: ${payloadRef}`);
  }
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(
      `payload sha256 mismatch for ${payloadRef}: expected ${expected.slice(0, 12)}, found ${actual.slice(0, 12)}`
    );
  }
  return JSON.parse(bytes.toString('utf8')) as StagedPayload;
}
