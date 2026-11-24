import { describe, expect, test } from 'bun:test';
import { isAllowedUpload } from './isAllowedUpload';

describe('isAllowedUpload', () => {
  test('accepts the canonical zip type', () => {
    expect(isAllowedUpload('application/zip', 'a.zip')).toBe(true);
  });

  test('accepts browser zip aliases (Windows Chrome/Edge)', () => {
    expect(isAllowedUpload('application/x-zip-compressed', 'a.zip')).toBe(true);
    expect(isAllowedUpload('application/x-zip', 'a.zip')).toBe(true);
    expect(isAllowedUpload('multipart/x-zip', 'a.zip')).toBe(true);
    expect(isAllowedUpload('application/x-gzip', 'a.tar.gz')).toBe(true);
  });

  test('ignores case and parameters', () => {
    expect(isAllowedUpload('Application/ZIP; charset=binary', 'a.zip')).toBe(true);
  });

  test('accepts octet-stream only for allowed archive extensions', () => {
    expect(isAllowedUpload('application/octet-stream', 'Backup.ZIP')).toBe(true);
    expect(isAllowedUpload('application/octet-stream', 'a.tgz')).toBe(true);
    expect(isAllowedUpload('application/octet-stream', 'setup.exe')).toBe(false);
    expect(isAllowedUpload('application/octet-stream', 'noext')).toBe(false);
  });

  test('still rejects types outside the allowlist', () => {
    expect(isAllowedUpload('application/x-msdownload', 'a.zip')).toBe(false);
    expect(isAllowedUpload('text/html', 'a.html')).toBe(false);
  });
});
