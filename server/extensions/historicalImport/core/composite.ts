// server/extensions/historicalImport/core/composite.ts
// Composite-key (join-table) support for entity types whose destination rows
// have NO `id` column.
//
// [why] Two destination tables in ChimeDeck are pure join tables with a
// varchar composite PRIMARY KEY and no surrogate id:
//   card_labels (card_id, label_id)
//   card_members(card_id, user_id)
// The plan contract addresses every target with a single string `target_id`,
// because provenance stores `target_ref = "<entity_type>:<target_id>"` under a
// UNIQUE constraint. Composite rows therefore need a canonical, injective
// encoding so the same string is (a) stable between the planner and the
// engine, (b) valid as a unique provenance target_ref, and (c) decodable back
// into the key columns for reads, drift checks and writes.
//
// Encoding: "<part_0>:<part_1>…" in the column order declared below.
// Every part must match ID_PART_PATTERN (no ':' and no whitespace), which makes
// decoding an unambiguous split and prevents an id from forging a key boundary.
// This module is intentionally dependency-free (no imports) so it stays pure
// and unit-testable without a database.

export class CompositeKeyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CompositeKeyError';
    this.code = code;
  }
}

// Canonical column order per composite-key entity type. Order is part of the
// wire contract: target_id "<first>:<second>" and must not be reordered.
export const COMPOSITE_KEY_COLUMNS: Record<string, readonly string[]> = {
  card_label: ['card_id', 'label_id'],
  card_member: ['card_id', 'user_id'],
};

export const COMPOSITE_TARGET_SEPARATOR = ':';

// Ids in ChimeDeck are uuid/string ids; the allowed alphabet keeps the
// separator unambiguous and rejects anything that could embed a boundary.
export const ID_PART_PATTERN = /^[A-Za-z0-9._~-]+$/;

export function compositeKeyColumns(entityType: string): readonly string[] | null {
  return COMPOSITE_KEY_COLUMNS[entityType] ?? null;
}

export function isCompositeKeyEntity(entityType: string): boolean {
  return Object.hasOwn(COMPOSITE_KEY_COLUMNS, entityType);
}

export function compositeKeyEntityTypes(): string[] {
  return Object.keys(COMPOSITE_KEY_COLUMNS);
}

// Build the canonical target_id for a composite row.
export function encodeCompositeTargetId(entityType: string, key: Record<string, string>): string {
  const columns = compositeKeyColumns(entityType);
  if (!columns) {
    throw new CompositeKeyError(
      'not-composite-entity',
      `${entityType} is not a composite-key entity type`
    );
  }
  const parts = columns.map((column) => {
    const value = key[column];
    if (typeof value !== 'string' || !ID_PART_PATTERN.test(value)) {
      throw new CompositeKeyError(
        'composite-part-invalid',
        `${entityType}.${column} must be a non-empty id matching ${String(ID_PART_PATTERN)}`
      );
    }
    return value;
  });
  return parts.join(COMPOSITE_TARGET_SEPARATOR);
}

// Split a composite target_id back into its key columns. Throws
// CompositeKeyError (fail-closed) on any malformed value.
export function decodeCompositeTargetId(
  entityType: string,
  targetId: string
): Record<string, string> {
  const columns = compositeKeyColumns(entityType);
  if (!columns) {
    throw new CompositeKeyError(
      'not-composite-entity',
      `${entityType} is not a composite-key entity type`
    );
  }
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new CompositeKeyError('composite-target-required', `${entityType} target_id is required`);
  }
  const parts = targetId.split(COMPOSITE_TARGET_SEPARATOR);
  if (parts.length !== columns.length) {
    throw new CompositeKeyError(
      'composite-target-invalid',
      `${entityType} target_id must be "${columns.join(COMPOSITE_TARGET_SEPARATOR)}" (${String(columns.length)} parts)`
    );
  }
  const key: Record<string, string> = {};
  parts.forEach((part, index) => {
    if (!ID_PART_PATTERN.test(part)) {
      throw new CompositeKeyError(
        'composite-target-invalid',
        `${entityType} target_id part ${String(index)} ("${columns[index] as string}") is not a valid id`
      );
    }
    key[columns[index] as string] = part;
  });
  return key;
}

// Attempt decoding; returns null instead of throwing (validation paths).
export function tryDecodeCompositeTargetId(
  entityType: string,
  targetId: string | null | undefined
): { key: Record<string, string> } | { error: CompositeKeyError } | null {
  if (!isCompositeKeyEntity(entityType)) return null;
  try {
    return { key: decodeCompositeTargetId(entityType, targetId ?? '') };
  } catch (err) {
    if (err instanceof CompositeKeyError) return { error: err };
    throw err;
  }
}

// The provenance target_ref string for any target. Single string, unique.
export function targetRef(entityType: string, targetId: string): string {
  return `${entityType}${COMPOSITE_TARGET_SEPARATOR}${targetId}`;
}
