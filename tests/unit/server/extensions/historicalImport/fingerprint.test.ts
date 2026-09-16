// tests/unit/server/extensions/historicalImport/fingerprint.test.ts
import { describe, expect, it } from 'bun:test';
import {
  canonicalJson,
  fingerprintJson,
  fingerprintFields,
  hashPlanDocument,
  CARD_FINGERPRINT_FIELDS,
} from '../../../../../server/extensions/historicalImport/core/fingerprint';

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('ignores undefined values but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });

  it('is stable across key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
});

describe('fingerprintJson / fingerprintFields', () => {
  it('changes when any fingerprinted field changes', () => {
    const row = { title: 'a', description: 'b', position: 'p', archived: false, list_id: 'l1' };
    const drifted = { ...row, title: 'drifted' };
    expect(fingerprintFields(row, CARD_FINGERPRINT_FIELDS)).not.toBe(
      fingerprintFields(drifted, CARD_FINGERPRINT_FIELDS),
    );
  });

  it('is independent of non-fingerprinted columns', () => {
    const row = { title: 'a', description: 'b', position: 'p', archived: false, list_id: 'l1', noise: 'x' };
    const same = { ...row, noise: 'y' };
    expect(fingerprintFields(row, CARD_FINGERPRINT_FIELDS)).toBe(
      fingerprintFields(same, CARD_FINGERPRINT_FIELDS),
    );
  });

  it('treats missing fields as null (canonical)', () => {
    expect(fingerprintFields({ title: 'a' }, ['title', 'description'])).toBe(
      fingerprintFields({ title: 'a', description: null }, ['title', 'description']),
    );
  });
});

describe('hashPlanDocument', () => {
  it('excludes the plan_hash field itself from the hash', () => {
    const plan = { plan_id: 'p1', operations: [], plan_hash: 'whatever' };
    const stripped = { plan_id: 'p1', operations: [] };
    expect(hashPlanDocument(plan)).toBe(hashPlanDocument(stripped));
  });

  it('changes on any operation change', () => {
    const plan = { plan_id: 'p1', operations: [{ op_id: 'a' }] };
    const changed = { plan_id: 'p1', operations: [{ op_id: 'b' }] };
    expect(hashPlanDocument(plan)).not.toBe(hashPlanDocument(changed));
  });
});
