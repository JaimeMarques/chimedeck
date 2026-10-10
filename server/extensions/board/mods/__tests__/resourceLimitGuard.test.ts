import { expect, test } from 'bun:test';

test('resourceLimitGuard real-handler subprocess regression', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/resourceLimitGuard.ts', import.meta.url).pathname], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  expect(stdout).toContain('verified');
}, 30_000);
