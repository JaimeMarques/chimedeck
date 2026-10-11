import { expect, test } from 'bun:test';

test('mergeSecurity real-handler subprocess regression', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/mergeSecurity.ts', import.meta.url).pathname], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  expect(stdout).toContain('verified');
}, 30_000);
