import { constants, lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export function isMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// Check existing components, including a dangling symlink. Missing descendants
// are allowed for creation, but never turn EACCES/ENOTDIR into "missing".
export function assertNoSymlinks(absolutePath: string): void {
  let current = parse(absolutePath).root;
  for (const component of relative(current, absolutePath).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('path-traversal-detected');
      if (realpathSync(current) !== current) throw new Error('path-traversal-detected');
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

// The absolute-only read API is internal. Its callers must obtain the path from
// resolveSpecsFilePath; this extra check prevents bypassing filesystem policy.
export function assertAbsoluteSpecsFile(absolutePath: string): string {
  if (!isAbsolute(absolutePath) || absolutePath.includes('\0'))
    throw new Error('path-must-be-relative');
  const normalized = resolve(absolutePath);
  if (
    !relative(parse(normalized).root, normalized).split(sep).includes('specs') ||
    !normalized.endsWith('.md')
  ) {
    throw new Error('specs-file-must-be-markdown');
  }
  assertNoSymlinks(normalized);
  return normalized;
}

// Linux: pin each directory with O_NOFOLLOW, then address children through the
// held descriptor, not a check-then-use pathname. Renaming/swapping a checked
// specs ancestor therefore cannot redirect a later read/write/unlink/readdir.
// Other platforms lack portable openat in Node; their fallback revalidates the
// path, but requires an exclusively controlled checkout (see SECURITY.md).
export async function withDirectory<T>(
  absolutePath: string,
  create: boolean,
  action: (directoryPath: string) => Promise<T>
): Promise<T> {
  assertNoSymlinks(absolutePath);
  const handles: FileHandle[] = [];
  const root = parse(absolutePath).root;
  try {
    let handle = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    handles.push(handle);
    let current = root;
    for (const component of relative(root, absolutePath).split(sep).filter(Boolean)) {
      const child = join(
        process.platform === 'linux' ? `/proc/self/fd/${String(handle.fd)}` : current,
        component
      );
      try {
        handle = await open(
          child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
      } catch (error) {
        if (!create || !isMissing(error)) throw error;
        try {
          await mkdir(child);
        } catch (mkdirError) {
          if (
            !(mkdirError instanceof Error) ||
            (mkdirError as NodeJS.ErrnoException).code !== 'EEXIST'
          )
            throw mkdirError;
        }
        handle = await open(
          child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
      }
      handles.push(handle);
      current = join(current, component);
    }
    if (process.platform !== 'linux') assertNoSymlinks(absolutePath);
    return await action(
      process.platform === 'linux' ? `/proc/self/fd/${String(handle.fd)}` : absolutePath
    );
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

export async function withFileParent<T>(
  absolutePath: string,
  create: boolean,
  action: (filePath: string) => Promise<T>
): Promise<T> {
  const normalized = assertAbsoluteSpecsFile(absolutePath);
  return withDirectory(dirname(normalized), create, (parent) =>
    action(join(parent, parse(normalized).base))
  );
}
