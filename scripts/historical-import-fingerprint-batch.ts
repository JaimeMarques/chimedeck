#!/usr/bin/env bun
// Batch the exact candidate-side projection and fingerprint implementation for
// external deterministic planners. Input/output are JSON on stdin/stdout so the
// private planner never reimplements Date or canonicalisation semantics.
import {
  CARD_FINGERPRINT_FIELDS,
  COMMENT_FINGERPRINT_FIELDS,
  FINGERPRINT_ALGORITHM,
  fingerprintFields,
  fingerprintJson,
} from '../server/extensions/historicalImport/core/fingerprint';

export interface RuntimeFingerprintRow {
  key: string;
  entity_type: string;
  row: Record<string, unknown>;
  timestamp_fields?: string[];
}

interface RuntimeFingerprintBatch {
  rows: RuntimeFingerprintRow[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function projectDatabaseRow(input: RuntimeFingerprintRow): Record<string, unknown> {
  const projected = { ...record(input.row, `${input.key}.row`) };
  for (const field of input.timestamp_fields ?? []) {
    const value = projected[field];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      throw new Error(`${input.key}.${field} must be an ISO timestamp or null`);
    }
    projected[field] = new Date(value);
  }
  return projected;
}

export function runtimeFingerprint(input: RuntimeFingerprintRow): string {
  const row = projectDatabaseRow(input);
  if (input.entity_type === 'card') return fingerprintFields(row, CARD_FINGERPRINT_FIELDS);
  if (input.entity_type === 'comment') return fingerprintFields(row, COMMENT_FINGERPRINT_FIELDS);
  return fingerprintJson(row);
}

export function fingerprintBatch(value: unknown): {
  algorithm: string;
  count: number;
  fingerprints: Record<string, string>;
} {
  const batch = record(value, 'batch') as unknown as RuntimeFingerprintBatch;
  if (!Array.isArray(batch.rows)) throw new Error('batch.rows must be an array');
  const fingerprints: Record<string, string> = {};
  for (const [index, item] of batch.rows.entries()) {
    const input = record(item, `rows[${index}]`) as unknown as RuntimeFingerprintRow;
    if (typeof input.key !== 'string' || input.key.length === 0) {
      throw new Error(`rows[${index}].key must be a non-empty string`);
    }
    if (Object.hasOwn(fingerprints, input.key)) throw new Error(`duplicate row key ${input.key}`);
    if (typeof input.entity_type !== 'string' || input.entity_type.length === 0) {
      throw new Error(`${input.key}.entity_type must be a non-empty string`);
    }
    if (
      input.timestamp_fields !== undefined &&
      (!Array.isArray(input.timestamp_fields) ||
        input.timestamp_fields.some((field) => typeof field !== 'string' || field.length === 0))
    ) {
      throw new Error(`${input.key}.timestamp_fields must be an array of non-empty strings`);
    }
    fingerprints[input.key] = runtimeFingerprint(input);
  }
  return { algorithm: FINGERPRINT_ALGORITHM, count: batch.rows.length, fingerprints };
}

if (import.meta.main) {
  const raw = await Bun.stdin.text();
  const input: unknown = JSON.parse(raw);
  process.stdout.write(`${JSON.stringify(fingerprintBatch(input))}\n`);
}
