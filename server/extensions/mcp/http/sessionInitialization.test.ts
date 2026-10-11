import { expect, test } from 'bun:test';

for (const scenario of [
  'delayed-insert',
  'rejected-insert',
  'delete-before-insert',
  'delete-before-rejection',
]) {
  test(`MCP HTTP session initialization: ${scenario}`, () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        new URL('./sessionInitialization.fixture.ts', import.meta.url).pathname,
        scenario,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain(`PASS ${scenario}`);
  });
}
