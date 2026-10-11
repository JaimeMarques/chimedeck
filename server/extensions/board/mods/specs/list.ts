// Enumerate specs only, without following repository symlinks.
import { realpathSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissing, withDirectory } from './filesystem';

export interface ListSpecsFilesInput {
  repoPath: string;
  includeHidden?: boolean;
}
export interface SpecsFileEntry {
  path: string;
  sizeBytes: number;
}

export async function listSpecsFiles({
  repoPath,
  includeHidden = true,
}: ListSpecsFilesInput): Promise<SpecsFileEntry[]> {
  const root = realpathSync(repoPath);
  const entries: SpecsFileEntry[] = [];
  const dirs = ['specs'];
  while (dirs.length > 0) {
    const current = dirs.shift();
    if (current === undefined) break;
    try {
      await withDirectory(join(root, current), false, async (directory) => {
        const items = await readdir(directory, { withFileTypes: true });
        for (const item of items) {
          if (!includeHidden && item.name.startsWith('.')) continue;
          // lstat, not stat: a leaf swapped for a symlink cannot be followed.
          const info = await lstat(join(directory, item.name)).catch((error: unknown) => {
            if (isMissing(error)) return null;
            throw error;
          });
          if (!info || info.isSymbolicLink()) continue;
          const path = `${current}/${item.name}`;
          if (info.isDirectory()) dirs.push(path);
          else if (info.isFile() && item.name.endsWith('.md'))
            entries.push({ path, sizeBytes: info.size });
        }
      });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return entries;
}
