import { expect, test } from 'bun:test';

test('rendered recovery hooks adopt singleton, use current callbacks and clean up', async () => {
  // [why] DOM globals stay in a subprocess so other suites retain their environment.
  const process = Bun.spawn([Bun.argv[0] ?? 'bun', 'run', `${import.meta.dir}/fixtures/recoveryHooks.ts`], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  expect(stdout).toContain('hook recovery and snapshot polling passed');
});
