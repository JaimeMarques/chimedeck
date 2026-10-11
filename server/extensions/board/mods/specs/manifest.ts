// Builds a specs manifest by walking the checked-out repository for markdown files.
import { listSpecsFiles, type SpecsFileEntry } from './list';
import { createHash } from 'node:crypto';
// Keep the manifest contract explicit without depending on unrelated board types.
export interface SpecsManifest {
  ref: string;
  fetchedAt: string;
  files: SpecsFileEntry[];
  etag: string;
}

function computeManifestEtag({ files, ref }: { files: SpecsFileEntry[]; ref: string }): string {
  const fingerprint = files.map((f) => `${f.path}:${String(f.sizeBytes)}`).join('\n') + '\n' + ref;
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 32);
}

export async function buildSpecsManifest({
  repoPath,
  ref,
  fetchedAt,
}: {
  repoPath: string;
  ref: string;
  fetchedAt: string;
}): Promise<SpecsManifest> {
  const files = await listSpecsFiles({ repoPath, includeHidden: false });
  const sorted = files.slice().sort((a, b) => a.path.localeCompare(b.path));
  const etag = computeManifestEtag({ files: sorted, ref });

  return { ref, fetchedAt, files: sorted, etag };
}
