import { readFile } from 'node:fs/promises';
import { canonicalJson, sha256Hex } from './fingerprint';

export const CARD_DESCRIPTION_AUTHORIZATION_ENV =
  'HISTORICAL_IMPORT_CARD_DESCRIPTION_AUTHORIZATION';
export const CARD_DESCRIPTION_AUTHORIZATION_CATEGORY = 'card-description-raw-correction';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface CardDescriptionAuthorizationEntry {
  authorization_id: string;
  source_id: string;
  target_id: string;
  source_description_sha256: string;
  target_description_sha256: string;
}

export interface CardDescriptionAuthorizationDocument {
  schema_version: 1;
  category: typeof CARD_DESCRIPTION_AUTHORIZATION_CATEGORY;
  decision_sha256: string;
  entries: CardDescriptionAuthorizationEntry[];
  manifest_sha256: string;
}

export interface LoadedCardDescriptionAuthorization {
  canonical_sha256: string;
  decision_sha256: string;
  entries: ReadonlyMap<string, CardDescriptionAuthorizationEntry>;
  document: CardDescriptionAuthorizationDocument;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly ${expected.join(',')}`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!HASH_PATTERN.test(result)) throw new Error(`${label} must be a lowercase SHA-256`);
  return result;
}

export function parseCardDescriptionAuthorization(
  value: unknown
): LoadedCardDescriptionAuthorization {
  const document = record(value, 'card description authorization');
  exactKeys(
    document,
    ['schema_version', 'category', 'decision_sha256', 'entries', 'manifest_sha256'],
    'card description authorization'
  );
  if (document.schema_version !== 1) {
    throw new Error('card description authorization schema_version must be 1');
  }
  if (document.category !== CARD_DESCRIPTION_AUTHORIZATION_CATEGORY) {
    throw new Error(
      `card description authorization category must be ${CARD_DESCRIPTION_AUTHORIZATION_CATEGORY}`
    );
  }
  const decisionSha256 = sha256(
    document.decision_sha256,
    'card description authorization decision_sha256'
  );
  if (!Array.isArray(document.entries) || document.entries.length === 0) {
    throw new Error('card description authorization entries must be a non-empty array');
  }

  const entries = new Map<string, CardDescriptionAuthorizationEntry>();
  const sourceIds = new Set<string>();
  const targetIds = new Set<string>();
  for (const [index, rawEntry] of document.entries.entries()) {
    const entry = record(rawEntry, `card description authorization entries[${index}]`);
    exactKeys(
      entry,
      [
        'authorization_id',
        'source_id',
        'target_id',
        'source_description_sha256',
        'target_description_sha256',
      ],
      `card description authorization entries[${index}]`
    );
    const parsed: CardDescriptionAuthorizationEntry = {
      authorization_id: nonEmptyString(entry.authorization_id, 'authorization_id'),
      source_id: nonEmptyString(entry.source_id, 'source_id'),
      target_id: nonEmptyString(entry.target_id, 'target_id'),
      source_description_sha256: sha256(
        entry.source_description_sha256,
        'source_description_sha256'
      ),
      target_description_sha256: sha256(
        entry.target_description_sha256,
        'target_description_sha256'
      ),
    };
    if (entries.has(parsed.authorization_id)) {
      throw new Error(`duplicate card description authorization_id ${parsed.authorization_id}`);
    }
    if (sourceIds.has(parsed.source_id)) {
      throw new Error(`duplicate card description authorization source_id ${parsed.source_id}`);
    }
    if (targetIds.has(parsed.target_id)) {
      throw new Error(`duplicate card description authorization target_id ${parsed.target_id}`);
    }
    entries.set(parsed.authorization_id, parsed);
    sourceIds.add(parsed.source_id);
    targetIds.add(parsed.target_id);
  }

  const body = { ...document };
  delete body.manifest_sha256;
  const canonicalSha256 = sha256Hex(canonicalJson(body));
  const manifestSha256 = sha256(
    document.manifest_sha256,
    'card description authorization manifest_sha256'
  );
  if (manifestSha256 !== canonicalSha256) {
    throw new Error('card description authorization manifest_sha256 is inconsistent');
  }

  return {
    canonical_sha256: canonicalSha256,
    decision_sha256: decisionSha256,
    entries,
    document: document as unknown as CardDescriptionAuthorizationDocument,
  };
}

export async function loadCardDescriptionAuthorization(): Promise<LoadedCardDescriptionAuthorization | null> {
  const path = Bun.env[CARD_DESCRIPTION_AUTHORIZATION_ENV] ?? '';
  if (!path) return null;
  try {
    const text = await readFile(path, 'utf8');
    return parseCardDescriptionAuthorization(JSON.parse(text) as unknown);
  } catch (error: unknown) {
    // Keep unrelated create/link/comment-correct/enrich plans available. A plan
    // that references this category still fails closed: external-input
    // verification reads the artifact independently, and the adapter exposes a
    // null loaded hash/allowlist.
    console.error('[historicalImport] failed to load card description authorization:', error);
    return null;
  }
}

export function cardDescriptionAuthorizationMatches(
  loaded: LoadedCardDescriptionAuthorization | null,
  input: CardDescriptionAuthorizationEntry
): boolean {
  if (!loaded) return false;
  const entry = loaded.entries.get(input.authorization_id);
  return (
    entry !== undefined &&
    entry.source_id === input.source_id &&
    entry.target_id === input.target_id &&
    entry.source_description_sha256 === input.source_description_sha256 &&
    entry.target_description_sha256 === input.target_description_sha256
  );
}
