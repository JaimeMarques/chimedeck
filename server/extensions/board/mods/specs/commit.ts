import { lstat } from 'node:fs/promises';
import { createGithubRepositoryGit } from '../githubRepository/git';
import { normalizeSpecsFilePath, resolveSpecsFilePath } from './resolvePath';

export interface CommitSpecsChangesInput {
  repoPath: string;
  branch: string;
  changedFiles: string[];
  message: string;
  actorId: string;
  boardId: string;
  botAlias: string;
  pushToken?: string | null;
}

export interface CommitSpecsChangesResult {
  commitHash: string;
  pushStatus: 'pushed' | 'pending';
  branch: string;
  changedFiles: string[];
  footer: {
    actorId: string;
    boardId: string;
    botAlias: string;
  };
}

function normalizeChangedFiles(changedFiles: string[]): string[] {
  return [...new Set(changedFiles.map((file) => file.trim()).filter((file) => file.length > 0))];
}

function buildCommitBody({
  message,
  actorId,
  boardId,
  botAlias,
  changedFiles,
}: {
  message: string;
  actorId: string;
  boardId: string;
  botAlias: string;
  changedFiles: string[];
}): string {
  const footerLines = [
    `Actor-Id: ${actorId}`,
    `Board-Id: ${boardId}`,
    `Bot-Alias: ${botAlias}`,
    `Changed-Files: ${changedFiles.join(', ')}`,
  ];
  return `${message.trim()}\n\n${footerLines.join('\n')}`;
}

export async function commitSpecsChanges({
  repoPath,
  branch,
  changedFiles,
  message,
  actorId,
  boardId,
  botAlias,
  pushToken = null,
}: CommitSpecsChangesInput): Promise<CommitSpecsChangesResult> {
  const files = [...new Set(normalizeChangedFiles(changedFiles).map(normalizeSpecsFilePath))];
  if (files.length === 0) {
    throw new Error('missing-changed-files');
  }

  // As with checkout/removal, callers must serialize repository mutations through
  // this entire validation/staging/commit sequence; Git uses filesystem pathnames.
  const git = createGithubRepositoryGit({ baseDir: repoPath, token: pushToken, botAlias });
  const existingFiles: string[] = [];
  for (const file of files) {
    const resolved = resolveSpecsFilePath({ repoPath, filePath: file });
    if (!resolved.ok) throw new Error(resolved.reason);
    const stat = await lstat(resolved.absolutePath).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && !stat.isFile()) throw new Error('specs-file-must-be-regular');
    if (!stat) {
      // Only regular files present in HEAD may be selected as deletions, even
      // when git rm has already removed their index entries.
      const entry = await git.raw(['--literal-pathspecs', 'ls-tree', '-z', 'HEAD', '--', file]);
      if (
        !/^(100644|100755) blob [a-f0-9]+\t/.test(entry) ||
        entry.slice(entry.indexOf('\t') + 1) !== `${file}\0`
      ) {
        throw new Error('specs-file-not-found');
      }
    } else {
      existingFiles.push(file);
    }
  }

  const commitBody = buildCommitBody({ message, actorId, boardId, botAlias, changedFiles: files });

  // --only commits the validated selection, retaining unrelated staged entries/hunks.
  if (existingFiles.length > 0) {
    await git.raw(['--literal-pathspecs', 'add', '--', ...existingFiles]);
  }
  const changes = await git.raw([
    '--literal-pathspecs',
    'diff',
    '--name-only',
    '-z',
    'HEAD',
    '--',
    ...files,
  ]);
  if (!changes) throw new Error('no-specs-changes');
  await git.raw(['--literal-pathspecs', 'commit', '--only', '-m', commitBody, '--', ...files]);

  const commitHash = (await git.raw(['rev-parse', 'HEAD'])).trim();

  if (pushToken) {
    await git.push('origin', branch);
    return {
      commitHash,
      pushStatus: 'pushed',
      branch,
      changedFiles: files,
      footer: { actorId, boardId, botAlias },
    };
  }

  return {
    commitHash,
    pushStatus: 'pending',
    branch,
    changedFiles: files,
    footer: { actorId, boardId, botAlias },
  };
}
