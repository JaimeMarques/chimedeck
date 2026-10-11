// Scope checks happen after POSIX normalization, before filesystem access.
import { realpathSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { assertNoSymlinks } from './filesystem';

export type ResolvePathResult = { ok: true; absolutePath: string } | { ok: false; reason: string };

export function normalizeSpecsFilePath(filePath: string): string {
  if (posix.isAbsolute(filePath) || win32.isAbsolute(filePath) || /^[a-z]:/i.test(filePath)) {
    throw new Error('path-must-be-relative');
  }
  if (filePath.includes('\0')) throw new Error('path-contains-null-byte');
  // Repository paths are POSIX, not URLs. Do not reinterpret encoded separators
  // or Windows separators differently at subsequent call sites.
  if (filePath.includes('\\') || /%(?:2e|2f|5c|00)/i.test(filePath))
    throw new Error('path-traversal-detected');
  const normalized = posix.normalize(filePath);
  if (!normalized.startsWith('specs/')) throw new Error('path-traversal-detected');
  if (!normalized.endsWith('.md')) throw new Error('specs-file-must-be-markdown');
  return normalized;
}

export function resolveSpecsFilePath({
  repoPath,
  filePath,
}: {
  repoPath: string;
  filePath: string;
}): ResolvePathResult {
  try {
    const normalized = normalizeSpecsFilePath(filePath);
    // A configured checkout alias may itself be a symlink; untrusted components
    // below its canonical root (including specs itself) may not be symlinks.
    const absolutePath = join(realpathSync(repoPath), normalized);
    assertNoSymlinks(absolutePath);
    return { ok: true, absolutePath };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'path-traversal-detected',
    };
  }
}
