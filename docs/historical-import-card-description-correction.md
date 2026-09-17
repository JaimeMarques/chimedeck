# Raw card-description correction contract

This administrative category exists only for a frozen, human-authorized Trello
source card whose already-native ChimeDeck target contains an HTML-entity-encoded
version of the same description. It does not broaden `correct` (comments only),
`link`, `create`, or `enrich`.

It is a planning/runtime contract, not live-apply authorization.

## Operation

```json
{
  "op_id": "op-correct-card-description-<source-id>",
  "entity_type": "card",
  "source_id": "<trello-card-id>",
  "target_id": "<chimedeck-card-id>",
  "operation": "correct_card_description",
  "provenance": {
    "source_system": "trello",
    "source_id": "<trello-card-id>",
    "evidence_refs": ["trello-export:cards/<trello-card-id>"],
    "board_id": "<existing-destination-board-id>"
  },
  "evidence_refs": ["trello-export:cards/<trello-card-id>"],
  "expected_target_fields": {
    "description": "<exact frozen destination raw description>"
  },
  "expected_target_fingerprint": "<fingerprintFields(expected_target_fields, ['description'])>",
  "expected_target_row_fingerprint": "<fingerprintRow(exact SELECT * destination card row)>",
  "card_description_authorization": {
    "authorization_id": "card-description:<source-id>:<target-id>",
    "decision_sha256": "<frozen human decision sha256>",
    "source_description_sha256": "<sha256 of exact source raw UTF-8 description>",
    "target_description_sha256": "<sha256 of exact target raw UTF-8 description>"
  },
  "payload_ref": "file:///.../op-correct-card-description-<source-id>.json",
  "dependencies": []
}
```

`expected_target_fields` contains exactly `description`; any second mutation
field is invalid. `expected_target_row_fingerprint` is mandatory and is computed
with this repository's `fingerprintRow` over the exact object returned by the
same Node/Bun `pg` driver used by the importer (`SELECT * FROM cards WHERE id =
?`). PostgreSQL `Date` values are normalized with `Date.toISOString()`
(millisecond precision) before canonical hashing; do not derive this fingerprint
from `psql` text or an independently formatted timestamp. The runtime locks and
re-reads `SELECT *` and checks both the exact description preimage and full-row
fingerprint before updating.

## Staged payload

The payload is private, path-contained by `HISTORICAL_IMPORT_PAYLOAD_ROOT`, and
byte-pinned by the normal `HISTORICAL_IMPORT_PAYLOAD_MANIFEST` entry for the
operation.

```json
{
  "entity_type": "card",
  "source_id": "<trello-card-id>",
  "fields": {
    "description": "<exact source raw description>"
  },
  "card_description_correction": {
    "authorization_id": "card-description:<source-id>:<target-id>",
    "authorization_sha256": "<authorization artifact canonical sha256>",
    "decision_sha256": "<frozen human decision sha256>",
    "target_id": "<chimedeck-card-id>",
    "source_description_sha256": "<sha256 exact fields.description UTF-8>",
    "target_description_sha256": "<sha256 exact expected_target_fields.description UTF-8>"
  }
}
```

The payload and `fields` objects accept exactly the keys shown. The runtime
requires all IDs/hashes to agree with the operation and loaded authorization
artifact, verifies both raw SHA-256 values, and requires HTML5 entity decoding of
the frozen target raw description to equal the source raw description byte-for-
byte as a JavaScript string. Equal raw strings, malformed evidence, NUL/unpaired
surrogates, normalization, trimming, sanitization, and partial decoding are
refused.

## Immutable authorization artifact

Configure its private server path as:

```text
HISTORICAL_IMPORT_CARD_DESCRIPTION_AUTHORIZATION=/private/.../card-description-authorization.json
```

Artifact shape:

```json
{
  "schema_version": 1,
  "category": "card-description-raw-correction",
  "decision_sha256": "bfe5135e63ad105668144df112bbe5fe0b5ae3ae4bae5429281230122b34a47a",
  "entries": [
    {
      "authorization_id": "card-description:6a7b2fa270a82a479e70e3a0:b80ad0ac-05e5-4350-81a1-b7aa1ea117be",
      "source_id": "6a7b2fa270a82a479e70e3a0",
      "target_id": "b80ad0ac-05e5-4350-81a1-b7aa1ea117be",
      "source_description_sha256": "<sha256 exact frozen source raw description>",
      "target_description_sha256": "<sha256 exact frozen target raw description>"
    },
    {
      "authorization_id": "card-description:6a7f709e824841b4398e243d:a08a8664-41b7-4ddd-9cc4-b771ca2c30ca",
      "source_id": "6a7f709e824841b4398e243d",
      "target_id": "a08a8664-41b7-4ddd-9cc4-b771ca2c30ca",
      "source_description_sha256": "<sha256 exact frozen source raw description>",
      "target_description_sha256": "<sha256 exact frozen target raw description>"
    },
    {
      "authorization_id": "card-description:6a8edbbb79931c780a93e9cf:21919137-fa78-48ab-9069-a571ea0b0064",
      "source_id": "6a8edbbb79931c780a93e9cf",
      "target_id": "21919137-fa78-48ab-9069-a571ea0b0064",
      "source_description_sha256": "<sha256 exact frozen source raw description>",
      "target_description_sha256": "<sha256 exact frozen target raw description>"
    }
  ],
  "manifest_sha256": "<sha256(canonicalJson(document without manifest_sha256))>"
}
```

The re-freeze worker must replace the six hash placeholders from the frozen raw
source/destination bytes and must not add another pair. IDs are one-to-one:
duplicate `authorization_id`, `source_id`, or `target_id` is invalid.

The plan pins the exact artifact and decision:

```json
{
  "input_preconditions": {
    "card_description_authorization": {
      "canonical_sha256": "<same value as artifact manifest_sha256>",
      "decision_sha256": "bfe5135e63ad105668144df112bbe5fe0b5ae3ae4bae5429281230122b34a47a"
    }
  }
}
```

Validation recomputes the configured artifact hash, verifies its self-hash and
strict schema, compares the plan pin to the same immutable artifact already
loaded into the execution adapter, and checks each operation against an exact
allowlist entry. An API caller's operation or payload assertion never authorizes
a pair by itself.

## Runtime and outcomes

Within one transaction the adapter:

1. verifies the manifested payload and immutable authorization;
2. locks the exact target card with `FOR UPDATE` and re-reads the full row;
3. refuses source/target provenance conflicts;
4. returns `noop` only when the exact source description is already present and
   this source owns the provenance claim;
5. checks the full-row fingerprint, exact target description preimage, and both
   raw hashes;
6. executes only `UPDATE cards SET description = ? WHERE id = ?`;
7. inserts or verifies `import_provenance` atomically; then checks the exact
   description postcondition.

No card API/action is invoked, so no domain event, notification, webhook,
automation, or mention delivery is dispatched. Native title, list, author-linked
data, timestamps, dates, position, archive state, money fields, short IDs/URLs,
and cover fields remain unchanged. PostgreSQL's existing search-vector trigger
may recompute the derived `search_vector` from title/description.

Outcome matrix:

- `applied`: exact preimage, full row, payload, hashes, authorization, and claims
  match; description plus provenance commit atomically.
- `noop`: exact corrected description is already present and the exact source owns
  the target claim; no row/provenance insert occurs.
- `blocked`: target missing, source claimed by another target, target claimed by
  another source/system, stale description preimage, stale full-row fingerprint,
  or concurrent row drift; no partial mutation/provenance.
- `failed`: malformed/unrepresentable payload, payload-manifest hash mismatch,
  source/target raw hash mismatch, entity-decoded mismatch, or immutable
  authorization mismatch; the transaction rolls back.
- Plan validation fails before execution for a non-card entity, wrong/missing
  target, any mutation field other than `description`, malformed hashes, missing
  full-row fingerprint/pin, or a pair absent from the allowlist.

A provenance-only reset is intentionally not a rollback of this correction: it
removes the claim but leaves the corrected description. A subsequent apply then
blocks on the frozen target preimage instead of recreating provenance. Recovery
requires restoring the pre-apply database backup (or a separately reviewed,
explicit remediation); never clear provenance as a way to replay this operation.

The existing global snapshot, external-input, plan-hash, destination-fingerprint,
OWNER/board authorization, dry-run, and apply-enable gates remain mandatory.
