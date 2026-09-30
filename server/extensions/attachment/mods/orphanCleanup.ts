// Remove unfinished uploads and explicitly abandoned comment images after one
// hour. Unposted confirmed drafts remain recoverable for thirty days.
import type { Knex } from 'knex';
import { db } from '../../../common/db';
import { deleteObject } from './s3/deleteObject';

const ORPHAN_TTL_MS = 60 * 60 * 1000; // 1 hour
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
interface OrphanAttachment {
  type: 'FILE';
  id: string;
  s3_key: string | null;
  thumbnail_key: string | null;
}

function whereOrphan(query: Knex.QueryBuilder, cutoff: string, draftCutoff: string): void {
  void query.where((pending) => {
    void pending.where({ status: 'PENDING' }).whereNull('comment_id')
      .whereNull('upload_confirmed_at').where('created_at', '<', cutoff);
  }).orWhere((abandoned) => {
    void abandoned.where({ upload_context: 'comment', comment_id: null })
      .where('abandoned_at', '<', cutoff);
  }).orWhere((draft) => {
    void draft.where({ upload_context: 'comment', comment_id: null }).whereNull('abandoned_at')
      .where('upload_confirmed_at', '<', draftCutoff);
  });
}

export async function cleanupOrphanAttachments(): Promise<void> {
  const cutoff = new Date(Date.now() - ORPHAN_TTL_MS).toISOString();
  const draftCutoff = new Date(Date.now() - DRAFT_TTL_MS).toISOString();

  const orphans = await db<OrphanAttachment>('attachments')
    .where({ type: 'FILE' })
    .where((query) => { whereOrphan(query, cutoff, draftCutoff); });

  for (const attachment of orphans) {
    await db.transaction(async (trx) => {
      // [why] Share the association lock and recheck eligibility: the upload
      // may have been confirmed, reclaimed or associated after selection.
      const orphan = await trx<OrphanAttachment>('attachments').where({ id: attachment.id })
        .where((query) => { whereOrphan(query, cutoff, draftCutoff); }).forUpdate().first();
      if (!orphan) return;
      const keysToDelete = [orphan.s3_key, orphan.thumbnail_key].filter(
        (key): key is string => typeof key === 'string' && key.length > 0,
      );
      for (const s3Key of keysToDelete) {
        try {
          await deleteObject({ s3Key });
        } catch {
          // Best-effort S3 deletion — proceed to remove DB row regardless
        }
      }
      await trx<OrphanAttachment>('attachments').where({ id: orphan.id }).delete();
    });
  }
}

// Schedule cleanup to run every 15 minutes when this module is imported.
// The interval reference is kept in module scope so it can be cleared in tests.
export const orphanCleanupInterval = setInterval(() => { void cleanupOrphanAttachments(); }, 15 * 60 * 1000);
