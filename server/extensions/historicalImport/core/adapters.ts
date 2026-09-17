// server/extensions/historicalImport/core/adapters.ts
// Production knex-backed ImporterDeps. Each entity create is a transaction:
// insert entity row + insert provenance, or neither.
//
// Payload resolution: payload_ref is a PRIVATE locator (e.g.
// "file:///var/lib/chimedeck/import-payloads/<plan>/<op>.json"). The server
// never receives payloads through the API — the operator stages them on the
// server host and grants access via filesystem. This keeps payloads out of
// logs, proxies and the tool transport entirely.
// [why parity] The dry-run preflight and the real apply share ONE body
// (`performCreate`): the only difference is commit vs rollback. A dry-run
// therefore fails exactly where an apply would fail, with the same error
// message — payload unreadable/absent, payload/manifest SHA-256 mismatch,
// unresolved historical identity, column/constraint/FK violation, or a
// provenance uniqueness conflict. Drift between rehearsal and apply is
// structural, not merely tested.
//
// [why timestamp projection] A staged payload may declare historical
// created_at/updated_at for any entity type, but only some destination tables
// have those columns (`lists`, `checklist_items`, `labels` and
// `card_custom_field_values` have neither; `boards`, `activities`,
// `comment_reactions`, `custom_fields` and `mentions` have `created_at` only).
// The declared timestamps are therefore projected through ./columns, which
// resolves the real destination columns from the live schema: a timestamp is
// written only where the column exists (historical fidelity preserved) and a
// proven absence is omitted and reported instead of failing the INSERT — with
// fail-fast, one list carrying a timestamp used to abort the whole plan.
//
// Payload resolution lives in ./payload.ts (staging-root containment +
// manifest SHA-256 verification) and is re-exported here for callers that
// used to import it from this module.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Knex } from 'knex';
import { db } from '../../../common/db';
import {
  compositeKeyColumns,
  decodeCompositeTargetId,
  targetRef,
  ID_PART_PATTERN,
} from './composite';
import type {
  EntityType,
  ImporterDeps,
  MutationInput,
  MutationResult,
  Operation,
  ProvenanceRow,
  RecoveryReport,
} from './plan';
import {
  exactHistoricalCommentContent,
  readVerifiedStagedPayload,
  validateStagedSourceReferences,
} from './payload';
import {
  applyHistoricalTimestamps,
  createCachedColumnProbe,
  queryTableColumns,
  type ColumnProbe,
  type HistoricalTimestampField,
} from './columns';
import { verifyAttachmentObjectPrecondition } from './objectPrecondition';
import {
  CARD_COVER_FIELDS,
  COMMENT_CORRECTION_FIELDS,
  canonicalJson,
  fingerprintFields,
  sha256Hex,
} from './fingerprint';

export {
  PAYLOAD_STAGING_ROOT,
  PAYLOAD_MANIFEST_PATH,
  resolveStagedPayload,
  type StagedPayload,
} from './payload';

// Identity map: Trello member id -> ChimeDeck user id. Loaded from a JSON
// artifact on the server host (operator-staged, private). Identities absent
// from the map are UNRESOLVED and must block operations referencing them.
export const IDENTITY_MAP_PATH = Bun.env['HISTORICAL_IMPORT_IDENTITY_MAP'] ?? '';

export async function loadIdentityMap(): Promise<Map<string, string>> {
  if (!IDENTITY_MAP_PATH) return new Map();
  try {
    const text = await readFile(IDENTITY_MAP_PATH, 'utf8');
    const parsed = JSON.parse(text) as Record<string, string>;
    return new Map(Object.entries(parsed));
  } catch (err) {
    console.error('[historicalImport] failed to load identity map:', err);
    return new Map();
  }
}

const ENTITY_TABLES: Record<EntityType, string> = {
  board: 'boards',
  list: 'lists',
  card: 'cards',
  comment: 'comments',
  comment_reaction: 'comment_reactions',
  attachment: 'attachments',
  checklist: 'checklists',
  checklist_item: 'checklist_items',
  label: 'labels',
  card_label: 'card_labels',
  card_member: 'card_members',
  custom_field: 'custom_fields',
  custom_field_value: 'card_custom_field_values',
  activity: 'activities',
  mention: 'mentions',
};

const SHORT_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SHORT_ID_LENGTH = 8;

function generatedShortId(): string {
  const bytes = randomBytes(SHORT_ID_LENGTH);
  return Array.from(bytes, (byte) => SHORT_ID_ALPHABET[byte % SHORT_ID_ALPHABET.length]).join('');
}

const SHORT_ID_TABLES: Partial<Record<EntityType, string>> = {
  board: 'boards',
  card: 'cards',
  list: 'lists',
  comment: 'comments',
  attachment: 'attachments',
};

// Resolve native short_id before entering the INSERT. The unique indexes remain
// the concurrency authority: a race rolls the whole entity+provenance
// transaction back and is surfaced identically by dry-run and apply.
async function ensureNativeShortId(
  trx: Knex.Transaction,
  entityType: EntityType,
  row: Record<string, unknown>
): Promise<void> {
  const table = SHORT_ID_TABLES[entityType];
  if (!table) return;
  const supplied = row.short_id;
  if (typeof supplied === 'string' && /^[A-Za-z0-9]{8}$/.test(supplied)) return;
  if (supplied !== undefined && supplied !== null) {
    throw new Error(`${entityType} payload short_id must be an 8-character alphanumeric string`);
  }

  const preferred = entityType === 'card' ? row.short_link : null;
  if (typeof preferred === 'string' && /^[A-Za-z0-9]{8}$/.test(preferred)) {
    const existing = await trx(table).where({ short_id: preferred }).first();
    if (!existing) {
      row.short_id = preferred;
      return;
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = generatedShortId();
    const existing = await trx(table).where({ short_id: candidate }).first();
    if (!existing) {
      row.short_id = candidate;
      return;
    }
  }
  throw new Error(`failed-to-generate-unique-short-id:${table}`);
}

export interface CreateWithProvenanceInput {
  entity_type: EntityType;
  source_id: string;
  target_id: string;
  payload_ref: string | null;
  plan_hash: string;
  operation: Operation;
  board_id?: string;
}

// A rehearsal (dry-run) runs every operation inside ONE transaction: each
// operation gets a savepoint it can release on success or roll back on failure,
// so pending writes are visible to the operations that depend on them while the
// scope's own rollback still discards everything. Outside a rehearsal every
// operation owns a whole transaction.
export interface OperationTransaction {
  trx: Knex.Transaction;
  nested: boolean;
}
export type OpenOperationTransaction = () => Promise<OperationTransaction>;

// Shared create body: resolve + verify the staged payload, resolve the
// historical author, then (in one transaction) insert the entity row and its
// provenance row. `mode: 'dry-run'` rolls the transaction back instead of
// committing, so nothing durable is written. Composite join rows may omit a
// payload because their complete destination row is their verified target key.
//
// Historical created_at/updated_at are projected through `projection` (see
// ./columns): written where the destination table really has the column, and
// omitted + reported where it provably does not. The projection is a required
// argument — a caller cannot silently bypass it.
export interface CreateTimestampProjection {
  probe: ColumnProbe;
  reportOmission(omission: {
    entity_type: EntityType;
    table: string;
    field: HistoricalTimestampField;
  }): void;
}

function storedSourceReferences(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed;
  }
  return [];
}

async function performCreate(
  input: CreateWithProvenanceInput,
  mode: 'apply' | 'dry-run',
  identityMap: Map<string, string>,
  projection: CreateTimestampProjection,
  openTrx?: OpenOperationTransaction
): Promise<{ target_id: string; created: boolean }> {
  const { entity_type, source_id, target_id, payload_ref, plan_hash, operation, board_id } = input;
  const table = ENTITY_TABLES[entity_type];
  const keyColumns = compositeKeyColumns(entity_type);
  const compositeKey = keyColumns ? decodeCompositeTargetId(entity_type, target_id) : null;
  const payload = await readVerifiedStagedPayload(payload_ref);
  const sourceReferences = payload ? validateStagedSourceReferences(payload) : [];
  if (!payload && !compositeKey) {
    throw new Error(
      `no staged payload resolved for ${entity_type}:${source_id} (payload_ref=${payload_ref})`
    );
  }
  if (payload && (payload.entity_type !== entity_type || payload.source_id !== source_id)) {
    throw new Error('staged payload identity does not match create operation');
  }
  if (entity_type === 'comment' && payload) {
    // Import content is a manifest-pinned historical record, not untrusted
    // request input. Validate only PostgreSQL representability; preserve it
    // verbatim for the row insert below.
    exactHistoricalCommentContent(payload.fields);
  }
  // FILE attachments are not representable until the exact staged object has
  // been read back and proven. This runs in both preflight and apply before any
  // row/provenance transaction begins.
  if (entity_type === 'attachment' && payload?.fields.type === 'FILE') {
    await verifyAttachmentObjectPrecondition(payload);
  }

  // Historical author must resolve to an existing user (if declared).
  let authorUserId: string | null = null;
  if (payload?.historical_author) {
    authorUserId = identityMap.get(payload.historical_author) ?? null;
    if (!authorUserId) {
      throw new Error(`unresolved historical identity: ${payload.historical_author}`);
    }
    const user = await db('users').where({ id: authorUserId }).first();
    if (!user) throw new Error(`mapped user ${authorUserId} does not exist`);
  }
  if (sourceReferences.length > 0) {
    if (entity_type !== 'activity' || !payload || !authorUserId) {
      throw new Error('detached source references require an attributed activity create');
    }
    if (
      typeof board_id !== 'string' ||
      payload.fields.board_id !== board_id ||
      payload.fields.entity_id !== board_id
    ) {
      throw new Error('detached list activity board anchor does not match operation provenance');
    }
    if (payload.fields.actor_id !== authorUserId) {
      throw new Error('detached list activity actor_id does not match resolved historical_author');
    }
  }

  const opened: OperationTransaction = openTrx
    ? await openTrx()
    : { trx: await db.transaction(), nested: false };
  const trx = opened.trx;
  try {
    const existingProv = (await trx('import_provenance')
      .where({ entity_type, source_id })
      .first()) as ProvenanceRow | undefined;
    if (existingProv) {
      if (existingProv.target_id !== target_id) {
        throw new Error(
          `provenance conflict: source ${entity_type}:${source_id} is already claimed by target ${existingProv.target_id} — create declares ${target_id}`
        );
      }
      if (
        canonicalJson(storedSourceReferences(existingProv.source_references)) !==
        canonicalJson(sourceReferences)
      ) {
        throw new Error('detached source references do not match stored provenance');
      }
      if (
        payload?.historical_author &&
        (existingProv.historical_source_actor_id !== payload.historical_author ||
          existingProv.historical_target_actor_id !== authorUserId)
      ) {
        throw new Error('historical actor provenance does not match the staged payload mapping');
      }
      await trx.rollback();
      return { target_id: existingProv.target_id, created: false };
    }

    let row: Record<string, unknown>;
    if (compositeKey && keyColumns) {
      const fields = { ...(payload?.fields ?? {}) };
      for (const column of keyColumns) {
        const provided = fields[column];
        if (provided !== undefined && String(provided as string) !== compositeKey[column]) {
          throw new Error(
            `payload field ${column} (${JSON.stringify(provided)}) disagrees with the target_id key (${compositeKey[column]})`
          );
        }
      }
      // Join tables have no id column. Referenced parent rows must already
      // exist; this makes an invalid planned join fail cleanly before its FK.
      delete fields.id;
      for (const ref of COMPOSITE_REFERENCES[entity_type] ?? []) {
        const value = compositeKey[ref.column];
        if (!value || !ID_PART_PATTERN.test(value)) {
          throw new Error(`${entity_type} target_id is missing a valid ${ref.column}`);
        }
        const referenced = await trx(ref.table).where({ id: value }).first();
        if (!referenced) {
          throw new Error(
            `referenced ${ref.table}.${ref.column} ${value} does not exist (the import never creates it)`
          );
        }
      }
      row = { ...fields, ...compositeKey };
    } else {
      row = { id: target_id, ...(payload?.fields ?? {}) };
      if (entity_type === 'comment') {
        if (!authorUserId) throw new Error('comment payload requires a resolved historical_author');
        row.user_id = authorUserId;
      }
      if (entity_type === 'attachment') {
        if (row.type === 'FILE' && !authorUserId) {
          throw new Error('FILE attachment payload requires a resolved historical_author');
        }
        if (authorUserId) row.uploaded_by = authorUserId;
        if (row.type === 'FILE' && row.status !== 'READY') {
          throw new Error('FILE attachment import requires status READY');
        }
      }
      if (entity_type === 'activity' && sourceReferences.length > 0) {
        const anchor = (await trx('boards').where({ id: board_id }).first()) as
          | { id: string }
          | undefined;
        if (!anchor) throw new Error('detached list activity destination board does not exist');
        row.entity_type = 'board';
        row.entity_id = board_id;
        row.board_id = board_id;
        row.actor_id = authorUserId;
      }
      const timestamps = await applyHistoricalTimestamps(
        projection.probe,
        trx,
        table,
        row,
        payload
      );
      for (const field of timestamps.omitted) {
        projection.reportOmission({ entity_type, table, field });
      }
      await ensureNativeShortId(trx, entity_type, row);

      // A board imported through direct knex writes must have the same ownership
      // invariant as native creation: the historical creator is the workspace's
      // actual OWNER, has an OWNER membership, and becomes board ADMIN atomically.
      if (entity_type === 'board') {
        if (!authorUserId) throw new Error('board payload requires a resolved historical_author');
        const workspaceId = row.workspace_id;
        if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
          throw new Error('board payload requires workspace_id');
        }
        const workspace = await trx('workspaces').where({ id: workspaceId }).first();
        if (!workspace || workspace.owner_id !== authorUserId) {
          throw new Error('board historical_author must resolve to the workspace owner');
        }
        const membership = await trx('memberships')
          .where({ workspace_id: workspaceId, user_id: authorUserId, role: 'OWNER' })
          .first();
        if (!membership) throw new Error('workspace owner is missing an OWNER membership');
      }
    }

    await trx(table).insert(row);
    if (entity_type === 'board') {
      await trx('board_members').insert({
        id: randomUUID(),
        board_id: target_id,
        user_id: authorUserId,
        role: 'ADMIN',
      });
    }
    await trx('import_provenance').insert({
      id: randomUUID(),
      source_system: 'trello',
      entity_type,
      source_id,
      target_id,
      target_ref: targetRef(entity_type, target_id),
      import_plan_hash: plan_hash,
      operation,
      source_references: JSON.stringify(sourceReferences),
      historical_source_actor_id: payload?.historical_author ?? null,
      historical_target_actor_id: authorUserId,
    });
    if (mode === 'dry-run') {
      // Rehearsal: the write path above is validated by the real schema
      // (NOT NULL/CHECK/FK/unique), then discarded. Inside a rehearsal scope the
      // savepoint is released instead, so the operations that depend on this row
      // see the pending write (the scope rollback still discards everything).
      if (opened.nested) await trx.commit();
      else await trx.rollback();
      return { target_id, created: true };
    }
    await trx.commit();
    return { target_id, created: true };
  } catch (err) {
    await trx.rollback();
    // Concurrency: another writer may claim the same source or composite row
    // between observation and insert. The unique constraints are authoritative;
    // report the winning provenance claim instead of incorrectly failing it.
    if (isUniqueViolation(err)) {
      const ownWinner = (await db('import_provenance')
        .where({ source_system: 'trello', entity_type, source_id })
        .where({ target_ref: targetRef(entity_type, target_id) })
        .first()) as ProvenanceRow | undefined;
      if (ownWinner) return { target_id: ownWinner.target_id, created: false };

      const sourceConflict = (await db('import_provenance')
        .where({ source_system: 'trello', entity_type, source_id })
        .first()) as ProvenanceRow | undefined;
      if (sourceConflict) {
        throw new Error(
          `provenance conflict: source ${entity_type}:${source_id} is already claimed by target ${sourceConflict.target_id} — create declares ${target_id}`
        );
      }
      const targetConflict = (await db('import_provenance')
        .where({ target_ref: targetRef(entity_type, target_id) })
        .first()) as ProvenanceRow | undefined;
      if (targetConflict) {
        throw new Error(
          `provenance conflict: target ${entity_type}:${target_id} is already claimed by ${targetConflict.source_system}:${targetConflict.source_id}`
        );
      }
    }
    throw err;
  }
}

interface LinkProvenanceInput {
  entity_type: EntityType;
  source_id: string;
  target_id: string;
  plan_hash: string;
  historical_source_actor_id?: string;
  historical_target_actor_id?: string;
}

// Shared link body: dry-run and apply execute the same provenance INSERT. In a
// rehearsal the nested transaction releases its savepoint so dependent ops can
// observe the claim; endDryRunScope rolls back the outer transaction. Without a
// rehearsal scope, dry-run rolls the standalone transaction back.
async function performLink(
  input: LinkProvenanceInput,
  mode: 'apply' | 'dry-run',
  openTrx?: OpenOperationTransaction
): Promise<void> {
  const opened: OperationTransaction = openTrx
    ? await openTrx()
    : { trx: await db.transaction(), nested: false };
  const trx = opened.trx;
  try {
    await trx('import_provenance').insert({
      id: randomUUID(),
      source_system: 'trello',
      entity_type: input.entity_type,
      source_id: input.source_id,
      target_id: input.target_id,
      target_ref: targetRef(input.entity_type, input.target_id),
      import_plan_hash: input.plan_hash,
      operation: 'link' satisfies Operation,
      historical_source_actor_id: input.historical_source_actor_id ?? null,
      historical_target_actor_id: input.historical_target_actor_id ?? null,
    });
    if (mode === 'dry-run' && !opened.nested) await trx.rollback();
    else await trx.commit();
  } catch (err) {
    if (!trx.isCompleted()) await trx.rollback();
    if (isUniqueViolation(err)) {
      throw new Error(
        `target ${targetRef(input.entity_type, input.target_id)} was claimed by another import between observation and link`
      );
    }
    throw err;
  }
}

function sameProjectedFields(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  fields: readonly string[]
): boolean {
  const project = (row: Record<string, unknown>) =>
    Object.fromEntries(
      fields.map((field) => {
        const value = row[field];
        return [field, value instanceof Date ? value.toISOString() : (value ?? null)];
      })
    );
  return canonicalJson(project(left)) === canonicalJson(project(right));
}

async function performMutation(
  input: MutationInput,
  mode: 'apply' | 'dry-run',
  identityMap: Map<string, string>,
  openTrx?: OpenOperationTransaction
): Promise<MutationResult> {
  const payload = await readVerifiedStagedPayload(input.payload_ref);
  if (!payload) throw new Error(`no staged payload resolved for mutation ${input.source_id}`);
  if (payload.entity_type !== input.entity_type || payload.source_id !== input.source_id) {
    throw new Error('staged payload identity does not match mutation operation');
  }

  const fields = input.operation === 'correct' ? COMMENT_CORRECTION_FIELDS : CARD_COVER_FIELDS;
  if (
    fingerprintFields(input.expected_target_fields, fields) !== input.expected_target_fingerprint
  ) {
    throw new Error('mutation expected fields do not match expected fingerprint');
  }

  const opened: OperationTransaction = openTrx
    ? await openTrx()
    : { trx: await db.transaction(), nested: false };
  const trx = opened.trx;
  try {
    const table = ENTITY_TABLES[input.entity_type];
    const current = (await trx(table).where({ id: input.target_id }).forUpdate().first()) as
      | Record<string, unknown>
      | undefined;
    if (!current) {
      await trx.rollback();
      return {
        status: 'blocked',
        reason: `mutation target ${input.entity_type}:${input.target_id} not found`,
      };
    }

    const sourceClaim = (await trx('import_provenance')
      .where({
        source_system: input.source_system,
        entity_type: input.entity_type,
        source_id: input.source_id,
      })
      .first()) as ProvenanceRow | undefined;
    const targetClaim = (await trx('import_provenance')
      .where({ target_ref: targetRef(input.entity_type, input.target_id) })
      .first()) as ProvenanceRow | undefined;
    if (sourceClaim && sourceClaim.target_id !== input.target_id) {
      await trx.rollback();
      return { status: 'blocked', reason: 'source is already claimed by another target' };
    }
    if (
      targetClaim &&
      (targetClaim.source_system !== input.source_system ||
        targetClaim.source_id !== input.source_id)
    ) {
      await trx.rollback();
      return { status: 'blocked', reason: 'target is already claimed by another source' };
    }

    const patch: Record<string, unknown> = {};
    if (input.operation === 'correct') {
      if (input.entity_type !== 'comment')
        throw new Error('correct is supported only for comments');
      if (current.deleted === true) {
        await trx.rollback();
        return { status: 'blocked', reason: 'deleted comments cannot be corrected' };
      }
      if (!payload.historical_author || payload.historical_author !== input.historical_author) {
        throw new Error('comment correction historical_author does not match its staged payload');
      }
      const authorUserId = identityMap.get(payload.historical_author);
      if (!authorUserId)
        throw new Error(`unresolved historical identity: ${payload.historical_author}`);
      const user = await trx('users').where({ id: authorUserId }).first();
      if (!user) throw new Error(`mapped user ${authorUserId} does not exist`);
      const content = exactHistoricalCommentContent(payload.fields);
      if (!payload.created_at || Number.isNaN(Date.parse(payload.created_at))) {
        throw new Error('comment correction requires a valid created_at');
      }
      if (!payload.updated_at || Number.isNaN(Date.parse(payload.updated_at))) {
        throw new Error('comment correction requires a valid updated_at');
      }
      const parentId = payload.fields.parent_id ?? null;
      if (parentId !== null && typeof parentId !== 'string') {
        throw new Error('comment correction parent_id must be a string or null');
      }
      if (parentId === input.target_id) throw new Error('comment cannot be its own parent');
      if (parentId) {
        const parent = await trx('comments').where({ id: parentId }).first();
        if (!parent || parent.card_id !== current.card_id || parent.parent_id !== null) {
          throw new Error(
            'comment correction parent_id must reference a root comment on the same card'
          );
        }
      }
      Object.assign(patch, {
        user_id: authorUserId,
        content,
        created_at: payload.created_at,
        updated_at: payload.updated_at,
        parent_id: parentId,
      });
    } else {
      if (input.entity_type !== 'card') throw new Error('enrich is supported only for cards');
      if (
        input.expected_target_fields.cover_attachment_id !== null ||
        input.expected_target_fields.cover_color !== null ||
        input.expected_target_fields.cover_size !== 'SMALL'
      ) {
        throw new Error('card cover enrich requires an empty native cover pre-image');
      }
      const attachmentId = payload.fields.cover_attachment_id ?? null;
      const color = payload.fields.cover_color ?? null;
      const size = payload.fields.cover_size;
      if ((attachmentId === null) === (color === null)) {
        throw new Error(
          'card cover enrich requires exactly one of cover_attachment_id or cover_color'
        );
      }
      if (size !== 'SMALL' && size !== 'FULL') {
        throw new Error('card cover enrich cover_size must be SMALL or FULL');
      }
      if (
        color !== null &&
        (typeof color !== 'string' || !/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color))
      ) {
        throw new Error('card cover enrich cover_color must be a hex color');
      }
      if (attachmentId !== null) {
        if (typeof attachmentId !== 'string' || attachmentId.length === 0) {
          throw new Error('card cover enrich cover_attachment_id must be a non-empty string');
        }
        const attachment = await trx('attachments')
          .where({ id: attachmentId, card_id: input.target_id, type: 'FILE', status: 'READY' })
          .first();
        if (
          !attachment ||
          typeof attachment.mime_type !== 'string' ||
          !attachment.mime_type.startsWith('image/')
        ) {
          throw new Error('card cover enrich attachment must be a READY image on the same card');
        }
        const attachmentClaim = await trx('import_provenance')
          .where({
            target_ref: targetRef('attachment', attachmentId),
            source_system: input.source_system,
          })
          .first();
        if (!attachmentClaim) throw new Error('card cover enrich attachment must be import-owned');
      }
      Object.assign(patch, {
        cover_attachment_id: attachmentId,
        cover_color: color,
        cover_size: size,
      });
    }

    const claim = sourceClaim ?? targetClaim;
    if (sameProjectedFields(current, patch, fields) && claim) {
      await trx.rollback();
      return { status: 'noop', target_id: input.target_id, reason: 'mutation already applied' };
    }
    if (
      fingerprintFields(current, fields) !== input.expected_target_fingerprint ||
      !sameProjectedFields(current, input.expected_target_fields, fields)
    ) {
      await trx.rollback();
      return { status: 'blocked', reason: 'target fingerprint drift — mutation prohibited' };
    }

    await trx(table).where({ id: input.target_id }).update(patch);
    if (!claim) {
      await trx('import_provenance').insert({
        id: randomUUID(),
        source_system: input.source_system,
        entity_type: input.entity_type,
        source_id: input.source_id,
        target_id: input.target_id,
        target_ref: targetRef(input.entity_type, input.target_id),
        import_plan_hash: input.plan_hash,
        operation: input.operation,
      });
    } else {
      await trx('import_provenance')
        .where({ id: claim.id })
        .update({ last_verified_at: trx.fn.now() });
    }
    const after = (await trx(table).where({ id: input.target_id }).first()) as Record<
      string,
      unknown
    >;
    if (!sameProjectedFields(after, patch, fields))
      throw new Error('mutation postcondition failed');

    if (mode === 'dry-run') {
      if (opened.nested) await trx.commit();
      else await trx.rollback();
    } else {
      await trx.commit();
    }
    return { status: 'applied', target_id: input.target_id };
  } catch (err) {
    if (!trx.isCompleted()) await trx.rollback();
    throw err;
  }
}

// Referenced-row pre-checks for composite-key (join-table) inserts. The import
// never creates the parents of a join row; a missing oracle row is a clean,
// explicit failure instead of a raw FK violation (23503).
const COMPOSITE_REFERENCES: Record<string, ReadonlyArray<{ column: string; table: string }>> = {
  card_label: [
    { column: 'card_id', table: 'cards' },
    { column: 'label_id', table: 'labels' },
  ],
  card_member: [
    { column: 'card_id', table: 'cards' },
    { column: 'user_id', table: 'users' },
  ],
};

// Valid id charset for composite parts (shared with the composite encoder).

export function createKnexDeps(identityMap: Map<string, string>): ImporterDeps {
  const trxOf = async (): Promise<Knex.Transaction> => db.transaction();
  // Dry-run rehearsal scope: ONE transaction shared by every operation of a
  // rehearsal. Each operation runs inside a savepoint so a failing operation can
  // be rolled back on its own, while a successful one stays visible to the ops
  // that depend on it (a created card's cover attachment and cover enrich can
  // only be rehearsed against the plan's own pending writes). The whole scope is
  // rolled back in endDryRunScope — nothing durable survives.
  let rehearsalScope: Knex.Transaction | null = null;

  const beginOperation = async (): Promise<OperationTransaction> => {
    if (rehearsalScope) {
      return { trx: (await rehearsalScope.transaction()) as Knex.Transaction, nested: true };
    }
    return { trx: await trxOf(), nested: false };
  };

  // Staged historical timestamps are projected from the LIVE destination schema
  // (one metadata query per table per deps instance), never from a hardcoded
  // table/column list: a timestamp is written only where the column exists, and
  // a proven absence is omitted and reported once per entity/field instead of
  // failing the INSERT.
  const columnProbe = createCachedColumnProbe(queryTableColumns);
  const reportedOmissions = new Set<string>();
  const projection: CreateTimestampProjection = {
    probe: columnProbe,
    reportOmission({ entity_type, table, field }) {
      const key = `${entity_type}:${field}`;
      if (reportedOmissions.has(key)) return;
      reportedOmissions.add(key);
      console.warn(
        `[historicalImport] staged ${field} cannot be preserved for ${entity_type}: table ${table} has no ${field} column — omitted`
      );
    },
  };

  return {
    loadedExternalInputHash(name) {
      if (name !== 'identity_map') return Promise.resolve(null);
      return Promise.resolve(sha256Hex(canonicalJson(Object.fromEntries(identityMap))));
    },

    async beginDryRunScope() {
      if (rehearsalScope) throw new Error('nested dry-run rehearsal scope');
      rehearsalScope = await db.transaction();
    },

    async endDryRunScope() {
      const scope = rehearsalScope;
      rehearsalScope = null;
      if (!scope) return;
      // Rollback, never commit: the rehearsal must leave the destination exactly
      // as it was, and writeAudit runs outside the scope afterwards.
      await scope.rollback();
    },

    async resolveBoardCreateWorkspace({ source_id, payload_ref }) {
      // Authorization witness for a board CREATE. The workspace is proven from
      // the staged board payload (identity + workspace_id) plus the same owner
      // gate the create path enforces — never from the plan's own claim.
      try {
        const payload = await readVerifiedStagedPayload(payload_ref);
        if (!payload) return { error: 'board create requires a staged board payload' };
        if (payload.entity_type !== 'board' || payload.source_id !== source_id) {
          return { error: 'staged payload identity does not match the board create operation' };
        }
        const workspaceId = payload.fields.workspace_id;
        if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
          return { error: 'staged board payload requires a workspace_id' };
        }
        const workspace = (await db('workspaces').where({ id: workspaceId }).first()) as
          | { owner_id?: string }
          | undefined;
        if (!workspace) return { error: 'staged board payload workspace does not exist' };
        if (
          typeof payload.historical_author !== 'string' ||
          payload.historical_author.length === 0
        ) {
          return { error: 'staged board payload requires a historical_author' };
        }
        const authorUserId = identityMap.get(payload.historical_author) ?? null;
        if (!authorUserId) {
          return { error: `unresolved historical identity: ${payload.historical_author}` };
        }
        if (workspace.owner_id !== authorUserId) {
          return { error: 'board historical_author must resolve to the workspace owner' };
        }
        const membership = await db('memberships')
          .where({ workspace_id: workspaceId, user_id: authorUserId, role: 'OWNER' })
          .first();
        if (!membership) return { error: 'workspace owner is missing an OWNER membership' };
        return { workspace_id: workspaceId };
      } catch (err: unknown) {
        // Unreadable, unverified (manifest SHA-256) or escapeless payload: the
        // witness cannot be proven, so the plan must not be authorized.
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    async fetchTarget(entityType, targetId) {
      const table = ENTITY_TABLES[entityType];
      // Join tables (card_labels, card_members) have no id column: address the
      // row by its composite key instead of `where({ id })`.
      const keyColumns = compositeKeyColumns(entityType);
      if (keyColumns) {
        const key = decodeCompositeTargetId(entityType, targetId);
        const row = await db(table).where(key).first();
        return (row as Record<string, unknown>) ?? null;
      }
      const row = await db(table).where({ id: targetId }).first();
      return (row as Record<string, unknown>) ?? null;
    },

    async fetchProvenance(entityType, sourceId) {
      const row = await db('import_provenance')
        .where({ entity_type: entityType, source_id: sourceId })
        .first();
      return (row as ProvenanceRow) ?? null;
    },

    async fetchProvenanceByTarget(entityType, targetId) {
      const row = await db('import_provenance')
        .where({ target_ref: targetRef(entityType, targetId) })
        .first();
      return (row as ProvenanceRow) ?? null;
    },

    resolveIdentity(sourceSystem, sourceUserId) {
      // Identity map is supplied by the operator (validated identity map
      // artifact); unresolved identities are absent => null => op blocked.
      void sourceSystem;
      return Promise.resolve(identityMap.get(sourceUserId) ?? null);
    },

    createWithProvenance(input) {
      return performCreate(input, 'apply', identityMap, projection, beginOperation);
    },

    // Dry-run preflight invokes the identical verified-payload/create body in
    // a rolled-back transaction, including composite-key row validation.
    async preflightCreate(input) {
      try {
        const result = await performCreate(
          input,
          'dry-run',
          identityMap,
          projection,
          beginOperation
        );
        return { ok: true, created: result.created, target_id: result.target_id } as const;
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) } as const;
      }
    },

    mutateWithProvenance(input) {
      return performMutation(input, 'apply', identityMap, beginOperation);
    },

    preflightMutation(input) {
      return performMutation(input, 'dry-run', identityMap, beginOperation);
    },

    linkProvenance(input) {
      return performLink(input, 'apply', beginOperation);
    },

    preflightLink(input) {
      return performLink(input, 'dry-run', beginOperation);
    },

    async writeAudit(entry) {
      // Append-only; audit failures must not break the engine but are logged.
      try {
        await db('import_audit_log').insert({
          id: randomUUID(),
          actor_user_id: entry.actor_user_id,
          action: entry.action,
          import_plan_hash: entry.import_plan_hash,
          operations_total: entry.operations_total,
          operations_applied: entry.operations_applied,
          operations_noop: entry.operations_noop,
          operations_failed: entry.operations_failed,
          detail: JSON.stringify(entry.detail),
        });
      } catch (err) {
        console.error('[historicalImport] audit write failed:', err);
      }
    },

    async clearProvenanceByPlan(planHash) {
      return db('import_provenance')
        .where({ import_plan_hash: planHash })
        .del() as unknown as Promise<number>;
    },

    async listProvenanceByPlan(planHash) {
      const rows = await db('import_provenance').where({ import_plan_hash: planHash });
      return rows as ProvenanceRow[];
    },

    async recoverByPlan(planHash) {
      return recoverByPlan(planHash);
    },
  } as ImporterDeps & {
    clearProvenanceByPlan(planHash: string): Promise<number>;
    listProvenanceByPlan(planHash: string): Promise<ProvenanceRow[]>;
    recoverByPlan(planHash: string): Promise<RecoveryReport>;
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// ---------------------------------------------------------------------------
// Destructive recovery (reset with recovery semantics)
// ---------------------------------------------------------------------------
//
// Deletes ONLY the rows this plan created (provenance operation='create'),
// dependents first, then clears the plan's provenance — so the same corrected
// plan can be re-executed without a restore.
//
// Safety model (all fail-closed, single transaction, nothing deleted on refusal):
// 1. only rows this plan created are candidates; rows imported by other plans or
//    native rows are never candidates;
// 2. FK edges are read from the live schema (pg_constraint), never hardcoded;
// 3. non-cascade edges (SET NULL / RESTRICT / NO ACTION) pointing at a deleted
//    row => refuse (a SET NULL would silently mutate content we did not create);
// 4. after deleting, row counts of every table reachable by CASCADE from a
//    deleted row must drop by exactly the number of rows we deleted => any
//    stronger cascade (native or foreign-plan children) rolls the whole
//    transaction back and reports a blocker.

interface FkEdge {
  name: string;
  child_table: string;
  child_columns: string[];
  parent_table: string;
  parent_columns: string[];
  on_delete: string; // 'c' cascade, 'n' set null, 'r' restrict, 'a' no action
}

async function loadForeignKeyEdges(
  trx: Knex.Transaction,
  parentTables: string[]
): Promise<FkEdge[]> {
  if (parentTables.length === 0) return [];
  const placeholders = parentTables.map(() => '?').join(',');
  const result = await trx.raw(
    `select con.conname as name,
            child.relname as child_table,
            parent.relname as parent_table,
            con.confdeltype as on_delete,
            array_agg(child_col.attname::text order by ck.ord)::text[] as child_columns,
            array_agg(parent_col.attname::text order by pk.ord)::text[] as parent_columns
       from pg_constraint con
       join pg_class child on child.oid = con.conrelid
       join pg_class parent on parent.oid = con.confrelid
       join pg_namespace n on n.oid = child.relnamespace
       join lateral unnest(con.conkey) with ordinality as ck(attnum, ord) on true
       join lateral unnest(con.confkey) with ordinality as pk(attnum, ord) on pk.ord = ck.ord
       join pg_attribute child_col on child_col.attrelid = child.oid and child_col.attnum = ck.attnum
       join pg_attribute parent_col on parent_col.attrelid = parent.oid and parent_col.attnum = pk.attnum
      where con.contype = 'f' and n.nspname = 'public' and parent.relname in (${placeholders})
      group by 1, 2, 3, 4`,
    parentTables
  );
  return ((result.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    name: String(row['name']),
    child_table: String(row['child_table']),
    child_columns: toColumnList(row['child_columns']),
    parent_table: String(row['parent_table']),
    parent_columns: toColumnList(row['parent_columns']),
    on_delete: String(row['on_delete']),
  }));
}

// pg returns `text[]` as a JS array but `name[]` (the pre-cast form) as the
// literal "{a,b}" string — normalise both so no FK edge is silently skipped.
function toColumnList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') {
    const trimmed = value.replace(/^\{/, '').replace(/\}$/, '');
    return trimmed.length === 0 ? [] : trimmed.split(',').map((v) => v.replace(/^"|"$/g, ''));
  }
  return [];
}

// Topological order over the tables we delete from: children before parents.
function deleteOrder(tables: string[], edges: FkEdge[]): string[] | null {
  const inDelete = new Set(tables);
  const parentsOf = new Map<string, Set<string>>(); // child -> parents
  const childrenOf = new Map<string, Set<string>>(); // parent -> children
  for (const t of tables) {
    parentsOf.set(t, parentsOf.get(t) ?? new Set());
    childrenOf.set(t, childrenOf.get(t) ?? new Set());
  }
  for (const edge of edges) {
    if (!inDelete.has(edge.child_table) || !inDelete.has(edge.parent_table)) continue;
    if (edge.child_table === edge.parent_table) continue; // self reference
    parentsOf.get(edge.child_table)?.add(edge.parent_table);
    childrenOf.get(edge.parent_table)?.add(edge.child_table);
  }
  const pending = new Map<string, number>(); // table -> number of children still to delete
  for (const t of tables) pending.set(t, (childrenOf.get(t) ?? new Set()).size);
  const ready = tables.filter((t) => (pending.get(t) ?? 0) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const table = ready.shift() as string;
    if (order.includes(table)) continue;
    order.push(table);
    for (const parent of parentsOf.get(table) ?? []) {
      const remaining = (pending.get(parent) ?? 0) - 1;
      pending.set(parent, remaining);
      if (remaining === 0) ready.push(parent);
    }
  }
  return order.length === tables.length ? order : null;
}

function cascadeClosure(tables: string[], edges: FkEdge[]): string[] {
  const seen = new Set(tables);
  const queue = [...tables];
  while (queue.length > 0) {
    const table = queue.shift() as string;
    for (const edge of edges) {
      if (edge.parent_table !== table || edge.on_delete !== 'c') continue;
      if (seen.has(edge.child_table)) continue;
      seen.add(edge.child_table);
      queue.push(edge.child_table);
    }
  }
  return [...seen];
}

async function countRows(trx: Knex.Transaction, table: string): Promise<number> {
  const row = (await trx(table).count({ n: '*' }).first()) as { n?: string | number } | undefined;
  return Number(row?.n ?? 0);
}

async function recoverByPlan(planHash: string): Promise<RecoveryReport> {
  const trx = await db.transaction();
  const blockers: RecoveryReport['blockers'] = [];
  try {
    const provenance = (await trx('import_provenance').where({
      import_plan_hash: planHash,
    })) as ProvenanceRow[];
    let created: Array<{ entity_type: string; target_id: string }> = provenance
      .filter((row) => row.operation === 'create')
      .map((row) => ({ entity_type: row.entity_type, target_id: row.target_id }));
    let candidatesFrom: 'provenance' | 'audit' = 'provenance';

    // A provenance-only reset removes the only live record of what the plan
    // created. The append-only audit log keeps it, so an operator who reset
    // first can still recover (remediation QA-6: recovery must not require a
    // database restore).
    if (created.length === 0) {
      const audits = (await trx('import_audit_log')
        .where({ import_plan_hash: planHash, action: 'reset' })
        .orderBy('created_at', 'desc')) as Array<{ detail: unknown }>;
      for (const audit of audits) {
        const detail =
          typeof audit.detail === 'string'
            ? (JSON.parse(audit.detail) as Record<string, unknown>)
            : (audit.detail as Record<string, unknown> | null);
        const recorded = detail?.['created_targets'];
        if (Array.isArray(recorded) && recorded.length > 0) {
          created = (recorded as Array<{ entity_type: string; target_id: string }>).filter(
            (r) => typeof r?.entity_type === 'string' && typeof r?.target_id === 'string'
          );
          candidatesFrom = 'audit';
          break;
        }
      }
    }

    // Candidate delete set: rows this plan created, addressed by primary key
    // (id column, or the composite key for join tables).
    const candidates = new Map<string, Array<Record<string, string>>>();
    for (const row of created) {
      const table = ENTITY_TABLES[row.entity_type as EntityType];
      if (!table) {
        blockers.push({
          code: 'recovery-unknown-entity-type',
          detail: `${row.entity_type} has no destination table`,
        });
        continue;
      }
      let key: Record<string, string>;
      try {
        key = compositeKeyColumns(row.entity_type)
          ? decodeCompositeTargetId(row.entity_type, row.target_id)
          : { id: row.target_id };
      } catch (err) {
        blockers.push({
          code: 'recovery-invalid-provenance-key',
          detail: `${row.entity_type} provenance row has an invalid target_id: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      const list = candidates.get(table) ?? [];
      list.push(key);
      candidates.set(table, list);
    }

    // Only rows that still exist are deletable; missing ones are reported.
    const deletable = new Map<string, Array<Record<string, string>>>();
    let alreadyAbsent = 0;
    for (const [table, keys] of candidates) {
      const present: Array<Record<string, string>> = [];
      for (const key of keys) {
        const found = await trx(table).where(key).first();
        if (found) present.push(key);
        else alreadyAbsent++;
      }
      if (present.length > 0) deletable.set(table, present);
    }

    const edges = await loadForeignKeyEdges(trx, [...deletable.keys()]);

    // (3) non-cascade edges: never let recovery mutate content we did not create.
    for (const edge of edges) {
      if (edge.on_delete === 'c') continue;
      if (edge.parent_columns.length !== 1) {
        blockers.push({
          code: 'recovery-unverifiable-fk-edge',
          detail: `${edge.name}: composite parent key cannot be verified`,
        });
        continue;
      }
      const parentColumn = edge.parent_columns[0] as string;
      const values = [
        ...new Set(
          (deletable.get(edge.parent_table) ?? []).map((k) => k[parentColumn]).filter(Boolean)
        ),
      ];
      if (values.length === 0) continue;
      const childColumn = edge.child_columns[0] as string;
      const row = (await trx(edge.child_table)
        .whereIn(childColumn, values as string[])
        .count({ n: '*' })
        .first()) as { n?: string | number } | undefined;
      const count = Number(row?.n ?? 0);
      if (count > 0) {
        blockers.push({
          code: 'recovery-non-cascade-dependency',
          detail: `${edge.child_table}.${childColumn} references ${edge.parent_table} rows this plan created (on delete ${edge.on_delete}); ${String(count)} row(s) would be mutated or orphaned`,
        });
      }
    }

    const order = deleteOrder([...deletable.keys()], edges);
    if (!order) {
      blockers.push({
        code: 'recovery-fk-cycle',
        detail: 'destination FK graph contains a cycle between plan rows',
      });
    }

    if (blockers.length === 0 && order) {
      const closure = cascadeClosure([...deletable.keys()], edges);
      const before = new Map<string, number>();
      for (const table of closure) before.set(table, await countRows(trx, table));

      let deleted = 0;
      for (const table of order) {
        for (const key of deletable.get(table) ?? []) {
          // knex/pg returns the affected row count as a number.
          const n: number = await trx(table).where(key).del();
          deleted += n;
        }
      }

      // (4) cascade postcondition: no table may lose more rows than we deleted.
      for (const table of closure) {
        const after = await countRows(trx, table);
        const expected = (before.get(table) ?? 0) - (deletable.get(table)?.length ?? 0);
        if (after !== expected) {
          blockers.push({
            code: 'recovery-unexpected-cascade',
            detail: `${table}: expected ${String(expected)} row(s) after recovery, found ${String(after)} — rows outside this plan were affected`,
          });
        }
      }

      if (blockers.length === 0) {
        const cleared: number = await trx('import_provenance')
          .where({ import_plan_hash: planHash })
          .del();
        await trx.commit();
        return {
          ok: true,
          mode: 'recovery',
          deleted,
          provenance_cleared: cleared,
          already_absent: alreadyAbsent,
          candidates_from: candidatesFrom,
          blockers: [],
        };
      }
    }

    await trx.rollback();
    return {
      ok: false,
      mode: 'recovery',
      deleted: 0,
      provenance_cleared: 0,
      already_absent: alreadyAbsent,
      candidates_from: candidatesFrom,
      blockers,
    };
  } catch (err) {
    await trx.rollback();
    throw err;
  }
}
