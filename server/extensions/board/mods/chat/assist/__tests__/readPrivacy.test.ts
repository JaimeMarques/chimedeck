import { expect, test } from 'bun:test';

for (const mode of ['scope', 'access', 'policy', 'caller']) {
  test(`read_attachments privacy: ${mode}`, async () => {
    // Module mocks stay in a child process, not the rest of the test suite.
    const child = Bun.spawn(
      [process.execPath, new URL('./fixtures/readPrivacy.ts', import.meta.url).pathname, mode],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain('verified');
  }, 30_000);
}
