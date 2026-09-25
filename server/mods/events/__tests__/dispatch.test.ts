import { expect, test } from 'bun:test';

test('dispatchEvent integrates automation normalization and webhook recipient filtering', async () => {
  const child = Bun.spawn(
    [process.execPath, new URL('./fixtures/dispatchPolicy.ts', import.meta.url).pathname],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  expect(stdout).toContain(
    'dispatch integration preserves automation naming and webhook recipient privacy'
  );
});
