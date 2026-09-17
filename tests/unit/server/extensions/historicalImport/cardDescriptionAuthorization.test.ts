import { describe, expect, it } from 'bun:test';
import {
  cardDescriptionAuthorizationMatches,
  parseCardDescriptionAuthorization,
} from '../../../../../server/extensions/historicalImport/core/cardDescriptionAuthorization';
import {
  exactHistoricalCardDescriptionCorrection,
  type StagedPayload,
} from '../../../../../server/extensions/historicalImport/core/payload';
import {
  canonicalJson,
  fingerprintRow,
  sha256Hex,
} from '../../../../../server/extensions/historicalImport/core/fingerprint';

const SOURCE_ID = 'source-card';
const TARGET_ID = 'target-card';
const AUTHORIZATION_ID = 'card-description:source-card:target-card';
const DECISION_SHA256 = 'd'.repeat(64);
const SOURCE_DESCRIPTION = 'literal & text ©';
const TARGET_DESCRIPTION = 'literal &amp; text &#169;';

function authorizationDocument() {
  const body = {
    schema_version: 1,
    category: 'card-description-raw-correction',
    decision_sha256: DECISION_SHA256,
    entries: [
      {
        authorization_id: AUTHORIZATION_ID,
        source_id: SOURCE_ID,
        target_id: TARGET_ID,
        source_description_sha256: sha256Hex(SOURCE_DESCRIPTION),
        target_description_sha256: sha256Hex(TARGET_DESCRIPTION),
      },
    ],
  } as const;
  return { ...body, manifest_sha256: sha256Hex(canonicalJson(body)) };
}

function payload(): StagedPayload {
  const authorization = authorizationDocument();
  return {
    entity_type: 'card',
    source_id: SOURCE_ID,
    fields: { description: SOURCE_DESCRIPTION },
    card_description_correction: {
      authorization_id: AUTHORIZATION_ID,
      authorization_sha256: authorization.manifest_sha256,
      decision_sha256: DECISION_SHA256,
      target_id: TARGET_ID,
      source_description_sha256: sha256Hex(SOURCE_DESCRIPTION),
      target_description_sha256: sha256Hex(TARGET_DESCRIPTION),
    },
  };
}

describe('card-description authorization artifact', () => {
  it('loads a self-hashed id-bounded entry and matches all ids and raw hashes', () => {
    const loaded = parseCardDescriptionAuthorization(authorizationDocument());

    expect(loaded.canonical_sha256).toBe(authorizationDocument().manifest_sha256);
    expect(
      cardDescriptionAuthorizationMatches(loaded, {
        authorization_id: AUTHORIZATION_ID,
        source_id: SOURCE_ID,
        target_id: TARGET_ID,
        source_description_sha256: sha256Hex(SOURCE_DESCRIPTION),
        target_description_sha256: sha256Hex(TARGET_DESCRIPTION),
      })
    ).toBe(true);
    expect(
      cardDescriptionAuthorizationMatches(loaded, {
        authorization_id: AUTHORIZATION_ID,
        source_id: SOURCE_ID,
        target_id: 'wrong-target',
        source_description_sha256: sha256Hex(SOURCE_DESCRIPTION),
        target_description_sha256: sha256Hex(TARGET_DESCRIPTION),
      })
    ).toBe(false);
  });

  it('rejects a changed entry even when the old manifest hash remains', () => {
    const document = authorizationDocument();
    document.entries[0]!.target_id = 'tampered-target';

    expect(() => parseCardDescriptionAuthorization(document)).toThrow(
      'card description authorization manifest_sha256 is inconsistent'
    );
  });

  it('rejects duplicate source or target ids so every pair remains one-to-one', () => {
    const document = authorizationDocument();
    const body = {
      ...document,
      entries: [
        document.entries[0]!,
        {
          ...document.entries[0]!,
          authorization_id: 'duplicate-entry',
          target_id: 'other-target',
        },
      ],
    };
    delete (body as { manifest_sha256?: string }).manifest_sha256;
    const duplicate = { ...body, manifest_sha256: sha256Hex(canonicalJson(body)) };

    expect(() => parseCardDescriptionAuthorization(duplicate)).toThrow(
      `duplicate card description authorization source_id ${SOURCE_ID}`
    );
  });
});

describe('exact historical card-description payload', () => {
  it('preserves source bytes while requiring exact HTML5 entity decoding of the frozen target', () => {
    const correction = exactHistoricalCardDescriptionCorrection(payload(), TARGET_DESCRIPTION);

    expect(correction.description).toBe(SOURCE_DESCRIPTION);
    expect(correction.evidence.target_id).toBe(TARGET_ID);
  });

  it('rejects extra mutation fields and raw/entity-decoded mismatches', () => {
    const extraField = payload();
    extraField.fields.title = 'not authorized';
    expect(() => exactHistoricalCardDescriptionCorrection(extraField, TARGET_DESCRIPTION)).toThrow(
      'card description correction fields must contain exactly description'
    );

    const mismatch = payload();
    mismatch.fields.description = 'not decoded target';
    mismatch.card_description_correction!.source_description_sha256 = sha256Hex(
      String(mismatch.fields.description)
    );
    expect(() => exactHistoricalCardDescriptionCorrection(mismatch, TARGET_DESCRIPTION)).toThrow(
      'card description correction raw/entity-decoded descriptions do not match exactly'
    );
  });

  it('fingerprints a database Date exactly like its frozen ISO row value', () => {
    const withDate = { id: TARGET_ID, updated_at: new Date('2026-09-17T00:00:00.000Z') };
    const frozen = { id: TARGET_ID, updated_at: '2026-09-17T00:00:00.000Z' };

    expect(fingerprintRow(withDate)).toBe(fingerprintRow(frozen));
  });
});
