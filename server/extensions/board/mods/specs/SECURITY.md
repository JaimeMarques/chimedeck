# Specs filesystem boundary

All public paths are repository-relative POSIX paths. Normalize before checking
`specs/` containment; only lowercase `.md` extensions are accepted. Windows/UNC
absolute paths, backslash separators, NUL and URL-encoded traversal/separator
forms are rejected, not decoded. Names, case and UTF-8 bytes are preserved.

The configured checkout path may be a trusted symlink alias: resolve it to its
canonical repository first. Reject every symlink below that canonical checkout,
including the specs root, ancestors, dangling links and leaf files. Missing
creation parents are made one at a time, never via recursive symlink-following
mkdir. Listing ignores link entries; a linked specs root is an error. The
manifest is also specs-only and skips hidden components before traversal.

On Linux, each operation holds directory descriptors opened with
`O_DIRECTORY | O_NOFOLLOW`. Children are accessed through the held parent's
`/proc/self/fd/<fd>` path. Files are opened with `O_NOFOLLOW`; reads, byte limits,
ETags and overwrite checks use the same file descriptor. Swapping an unopened
component for a symlink fails closed; swapping an already-open parent cannot
redirect access to a replacement symlink. The directory-swap regression proves
this using actual rename/symlink/read/write/unlink operations and outside
sentinels. `/proc` must be available; there is no insecure Linux fallback.

**Threat limits:** descriptor pinning protects inode identity, not continued
membership in the current pathname tree. Concurrent renames may move the pinned
original directory and leave returned pathnames stale. It is not a transaction
or an optimistic-concurrency lock: simultaneous valid writers can still race an
If-Match check. Trusted checkout management must serialize git checkout/removal
with specs edits; repo clones and their host ancestors must be app-controlled.
Local privileged writers, hostile hardlinks, mount changes and content mutations
through other descriptors are not covered. A Git tree cannot encode hardlinks.

**Non-Linux:** Node has no portable openat API. The validated pathname fallback
rejects static repository symlinks but does NOT protect against hostile
concurrent intermediate-directory swaps. Use it only with an exclusively
app-controlled checkout and no concurrent local filesystem writer. Do not claim
Linux descriptor-relative race guarantees on other platforms; no non-Linux
runtime gate was run here.

The absolute-only low-level read API is internal, not a path authorization API:
external callers must first use `resolveSpecsFilePath` with their trusted repo
root. Its independent no-follow descriptor walk defends against a path swapped
between resolution and reading.
