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

export const PAYLOAD_STAGING_ROOT = Bun.env['HISTORICAL_IMPORT_PAYLOAD_ROOT'] ?? '';

// Path to the payload-manifest.json produced with the plan. This is mandatory
// whenever an operation uses payload_ref: without it the importer cannot prove
// that staged bytes equal the reviewed payload bytes, so both dry-run and apply
// fail closed rather than silently skipping integrity verification.
export const PAYLOAD_MANIFEST_PATH = Bun.env['HISTORICAL_IMPORT_PAYLOAD_MANIFEST'] ?? '';

// Payload staged-file shape. The staged file carries the historical author
// and timestamps; the API/manifest only carries the reference.
export interface StagedPayload {
  entity_type: string;
  source_id: string;
  historical_author?: string; // Trello member id
  created_at?: string; // ISO
  updated_at?: string; // ISO
  fields: Record<string, unknown>; // entity column => value
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Read + hash a staged payload file, enforcing staging-root containment.
async function readStagedFile(payloadRef: string): Promise<{ path: string; bytes: Buffer }> {
  if (!PAYLOAD_STAGING_ROOT) {
    throw new Error('HISTORICAL_IMPORT_PAYLOAD_ROOT is not configured on the server');
  }
  // Only file: refs under the configured staging root are allowed — no
  // arbitrary filesystem reads.
  if (!payloadRef.startsWith('file://')) {
    throw new Error(`unsupported payload_ref scheme: ${payloadRef.split(':')[0]}`);
  }
  const rawPath = payloadRef.slice('file://'.length);
  const stagingRoot = resolve(PAYLOAD_STAGING_ROOT);
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
}

let cachedManifest: PayloadManifest | null = null;

// Load (once per process) the operator-staged payload manifest. A malformed
// manifest is a hard failure — silently skipping the integrity check would
// turn a misconfiguration into an unverified apply.
export async function loadPayloadManifest(): Promise<PayloadManifest> {
  if (!PAYLOAD_MANIFEST_PATH) {
    throw new Error('HISTORICAL_IMPORT_PAYLOAD_MANIFEST is not configured on the server');
  }
  if (cachedManifest) return cachedManifest;
  const text = await readFile(PAYLOAD_MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(text) as { payloads?: Array<{ payload_ref?: string; sha256?: string }> };
  const entries = Array.isArray(parsed.payloads) ? parsed.payloads : null;
  if (!entries) {
    throw new Error(`payload manifest ${PAYLOAD_MANIFEST_PATH} has no payloads[] array`);
  }
  const byRef = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry.payload_ref !== 'string' || !/^[0-9a-f]{64}$/.test(String(entry.sha256))) {
      throw new Error(`payload manifest ${PAYLOAD_MANIFEST_PATH} has a malformed entry`);
    }
    byRef.set(entry.payload_ref, entry.sha256 as string);
  }
  cachedManifest = { byRef };
  return cachedManifest;
}

// Test seam: drop the memoised manifest (env may change between tests).
export function resetPayloadManifestCache(): void {
  cachedManifest = null;
}

export async function resolveStagedPayload(payloadRef: string | null): Promise<StagedPayload | null> {
  if (!payloadRef) return null;
  const { bytes } = await readStagedFile(payloadRef);
  return JSON.parse(bytes.toString('utf8')) as StagedPayload;
}

// Read a staged payload and verify it against the configured manifest.
// Throws (never returns a payload) when the reference is absent from the
// manifest or the bytes differ from the manifested SHA-256.
export async function readVerifiedStagedPayload(payloadRef: string | null): Promise<StagedPayload | null> {
  if (!payloadRef) return null;
  const { bytes } = await readStagedFile(payloadRef);
  const manifest = await loadPayloadManifest();
  const expected = manifest.byRef.get(payloadRef);
  if (!expected) {
    throw new Error(
      `payload_ref is absent from the configured payload manifest: ${payloadRef}`,
    );
  }
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(
      `payload sha256 mismatch for ${payloadRef}: expected ${expected.slice(0, 12)}, found ${actual.slice(0, 12)}`,
    );
  }
  return JSON.parse(bytes.toString('utf8')) as StagedPayload;
}
