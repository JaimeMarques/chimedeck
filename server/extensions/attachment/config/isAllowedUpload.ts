// Fork-only: tolerant MIME check for attachment uploads.
// Browsers do not agree on archive MIME types: Chrome/Edge on Windows report
// `.zip` as `application/x-zip-compressed`, some send `application/x-zip`, and
// a file with no OS association arrives as `''` (sent as
// `application/octet-stream`). The strict allowlist rejected all of these.
import { ALLOWED_MIME_TYPES } from './allowedTypes';

/** Browser/OS aliases for types already in ALLOWED_MIME_TYPES. */
export const MIME_TYPE_ALIASES: Record<string, string> = {
  'application/x-zip-compressed': 'application/zip',
  'application/x-zip': 'application/zip',
  'multipart/x-zip': 'application/zip',
  'application/x-gzip': 'application/gzip',
  'application/x-gtar': 'application/x-tar',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
};

/** Extensions accepted when the browser sends no useful MIME type. */
const EXTENSION_TYPES: Record<string, string> = {
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
};

const GENERIC_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * True when the upload's declared MIME type (or, for a generic type, its file
 * extension) maps to an entry of ALLOWED_MIME_TYPES. The declared type is kept
 * as-is for storage and the presigned PUT, because the client sends that same
 * Content-Type header.
 */
export function isAllowedUpload(mimeType: string, filename: string): boolean {
  const type = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (ALLOWED_MIME_TYPES.includes(type)) return true;
  const alias = MIME_TYPE_ALIASES[type];
  if (alias && ALLOWED_MIME_TYPES.includes(alias)) return true;
  if (GENERIC_TYPES.has(type)) {
    const byExt = EXTENSION_TYPES[extensionOf(filename)];
    return byExt !== undefined && ALLOWED_MIME_TYPES.includes(byExt);
  }
  return false;
}
