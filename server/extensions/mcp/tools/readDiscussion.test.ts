import { expect, test } from 'bun:test';

// [why] Isolate configuration/module mocks from the rest of the Bun test suite.
for (const scenario of [
  'threaded', 'ordering', 'empty', 'unthreaded', 'direct', 'encoded-id', 'denied', 'html', 'null',
  'malformed', 'missing-count', 'missing', 'network', 'validation', 'partial',
  'count-less', 'count-more', 'wrong-parent', 'wrong-card', 'duplicate', 'root-duplicate',
  'nested', 'deleted', 'root-pagination', 'reply-pagination', 'redaction',
]) {
  test(`discussion MCP contract: ${scenario}`, () => {
    const result = Bun.spawnSync([process.execPath, new URL('./readDiscussion.fixture.ts', import.meta.url).pathname, scenario], {
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain(`PASS ${scenario}`);
  });
}
