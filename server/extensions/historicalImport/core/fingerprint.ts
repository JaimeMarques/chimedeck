// server/extensions/historicalImport/core/fingerprint.ts
// Pure canonicalisation + fingerprint helpers for the historical-import plan.
// [why] Pure (no imports) so unit tests exercise it without a DB and so the
// exact fingerprint algorithm is versioned and reproducible.
import { createHash } from 'node:crypto';

export const FINGERPRINT_ALGORITHM = 'sha256-fingerprint-v1';
export const PLAN_HASH_ALGORITHM = 'sha256-plan-v1';

// Canonicalise a JSON value: object keys sorted recursively, no whitespace.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// Fingerprint an arbitrary subset of an entity — used for
// expected_target_fingerprint and computed target fingerprints.
export function fingerprintJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

// Hash a full plan manifest (without the plan's own hash fields).
export function hashPlanDocument(plan: unknown): string {
  const doc = plan as Record<string, unknown>;
  const stripped: Record<string, unknown> = { ...doc };
  delete stripped.plan_hash;
  delete stripped.snapshot_hash;
  return sha256Hex(canonicalJson(stripped));
}

// Standard content fingerprint subset for a card row (subset importers may
// choose to compare; the plan author decides which fields to include).
export const CARD_FINGERPRINT_FIELDS = [
  'title',
  'description',
  'position',
  'archived',
  'due_date',
  'due_complete',
  'start_date',
  'list_id',
] as const;

export const COMMENT_FINGERPRINT_FIELDS = [
  'card_id',
  'user_id',
  'content',
  'parent_id',
] as const;

// Build a fingerprint over selected fields of a row.
export function fingerprintFields(
  row: Record<string, unknown> | undefined | null,
  fields: readonly string[],
): string {
  const subset: Record<string, unknown> = {};
  for (const f of fields) subset[f] = row?.[f] ?? null;
  return fingerprintJson(subset);
}
