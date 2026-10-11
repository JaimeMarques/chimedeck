import { expect, test } from 'bun:test';

// Keep fake clocks and module mocks out of other MCP suites.
for (const scenario of [
  'active-owner',
  'rejected-db-touch',
  'intruder',
  'idle',
  'unauthenticated',
  'unknown-session',
  'read-only-lookup',
  'db-only-reinitialize',
  'owner-get',
  'owner-delete',
  ...['PUT', 'PATCH', 'OPTIONS'].map((method) => `unsupported-${method}`),
]) {
  test(`MCP HTTP session liveness: ${scenario}`, () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        new URL('./sessionLiveness.fixture.ts', import.meta.url).pathname,
        scenario,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain(`PASS ${scenario}`);
  });
}
