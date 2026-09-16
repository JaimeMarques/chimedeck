// tests/unit/server/extensions/historicalImport/compositeKeys.test.ts
// Pure unit tests for the composite-key (join-table) target_id encoding.
// No DB, no fixtures: the encoding is the wire contract between the planner and
// the engine, so it is pinned here.
import { describe, expect, it } from 'bun:test';
import {
  COMPOSITE_KEY_COLUMNS,
  CompositeKeyError,
  compositeKeyColumns,
  compositeKeyEntityTypes,
  decodeCompositeTargetId,
  encodeCompositeTargetId,
  isCompositeKeyEntity,
  targetRef,
  tryDecodeCompositeTargetId,
} from '../../../../../server/extensions/historicalImport/core/composite';

const CARD = 'crd_0f2a-1111.2222';
const LABEL = 'lbl_9c3b';
const USER = 'usr_alice_0001';

describe('composite key registry', () => {
  it('declares exactly the join tables that have no id column', () => {
    // card_labels(card_id,label_id) and card_members(card_id,user_id) are the
    // only composite-key destination tables in the schema.
    expect(compositeKeyEntityTypes().sort()).toEqual(['card_label', 'card_member']);
    expect(COMPOSITE_KEY_COLUMNS['card_label']).toEqual(['card_id', 'label_id']);
    expect(COMPOSITE_KEY_COLUMNS['card_member']).toEqual(['card_id', 'user_id']);
  });

  it('identifies composite entities only', () => {
    expect(isCompositeKeyEntity('card_label')).toBe(true);
    expect(isCompositeKeyEntity('card_member')).toBe(true);
    expect(isCompositeKeyEntity('card')).toBe(false);
    expect(compositeKeyColumns('card')).toBeNull();
  });
});

describe('encode / decode', () => {
  it('round-trips a card_label key in the declared column order', () => {
    const encoded = encodeCompositeTargetId('card_label', { card_id: CARD, label_id: LABEL });
    expect(encoded).toBe(`${CARD}:${LABEL}`);
    expect(decodeCompositeTargetId('card_label', encoded)).toEqual({ card_id: CARD, label_id: LABEL });
  });

  it('round-trips a card_member key', () => {
    const encoded = encodeCompositeTargetId('card_member', { card_id: CARD, user_id: USER });
    expect(encoded).toBe(`${CARD}:${USER}`);
    expect(decodeCompositeTargetId('card_member', encoded)).toEqual({ card_id: CARD, user_id: USER });
  });

  it('produces a stable, unique provenance target_ref per composite row', () => {
    const a = targetRef('card_label', `${CARD}:${LABEL}`);
    const b = targetRef('card_label', `${CARD}:lbl_other`);
    expect(a).toBe(`card_label:${CARD}:${LABEL}`);
    expect(a).not.toBe(b);
  });

  it('rejects a key with a missing part', () => {
    const result = tryDecodeCompositeTargetId('card_label', CARD);
    expect(result && 'error' in result).toBe(true);
    expect((result as { error: CompositeKeyError }).error.code).toBe('composite-target-invalid');
  });

  it('rejects a key with too many parts (forged boundary)', () => {
    const result = tryDecodeCompositeTargetId('card_label', `${CARD}:${LABEL}:extra`);
    expect(result && 'error' in result).toBe(true);
  });

  it('rejects an empty target_id', () => {
    expect(() => decodeCompositeTargetId('card_member', '')).toThrow(CompositeKeyError);
  });

  it('rejects parts that could embed a separator or whitespace', () => {
    expect(() => encodeCompositeTargetId('card_label', { card_id: CARD, label_id: 'a:b' })).toThrow(
      /must be a non-empty id/,
    );
    expect(() => encodeCompositeTargetId('card_label', { card_id: 'a b', label_id: LABEL })).toThrow(
      /must be a non-empty id/,
    );
    expect(() => encodeCompositeTargetId('card_label', { card_id: CARD, label_id: '' })).toThrow(
      /must be a non-empty id/,
    );
  });

  it('rejects encoding for a non-composite entity type', () => {
    expect(() => encodeCompositeTargetId('card', { id: CARD })).toThrow(/not a composite-key entity/);
  });

  it('returns null from tryDecode for non-composite entity types', () => {
    expect(tryDecodeCompositeTargetId('card', CARD)).toBeNull();
  });
});
