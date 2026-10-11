import { expect, test } from 'bun:test';

const scenarios = [
  ...['membership', 'board-grant', 'guest', 'public', 'workspace'].flatMap((revocation) =>
    ['broad', 'direct'].map((branch) => `paused-${revocation}-${branch}`)
  ),
  'policy',
  'scope',
  'caller',
  'queued-revocation',
];
for (const scenario of scenarios) {
  test(`search_cards privacy: ${scenario}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('./fixtures/searchPrivacy.ts', import.meta.url).pathname,
        scenario,
      ],
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
