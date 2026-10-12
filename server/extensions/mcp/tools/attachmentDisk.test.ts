import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMcpTools } from '../registerTools';
import { config } from '../config';
import { apiError, defineToolScenarios, json } from './toolSupport.fixture';

const row = {
  id: 'file1',
  type: 'FILE',
  status: 'READY',
  name: 'file.txt',
  size_bytes: 5,
  content_type: 'text/plain',
};
defineToolScenarios(
  import.meta,
  (server, token) => {
    registerMcpTools(server, token, {
      transport: Bun.argv.some((arg) => arg.startsWith('hosted discovery')) ? 'http' : 'stdio',
    });
  },
  {
    'local header deadline fails before destination mutation': async (h) => {
      const folder = await mkdtemp(join(tmpdir(), 'chimedeck-header-test-'));
      const destPath = join(folder, 'previous.txt');
      try {
        await writeFile(destPath, 'previous');
        config.timeoutMs = 25;
        h.respond(async ({ path }) => {
          if (!path.endsWith('/view')) return json({ data: [row] });
          await new Promise((accept) => setTimeout(accept, 100));
          return new Response('hello', { headers: { 'Content-Type': 'text/plain' } });
        });
        await h.fail(
          'download_attachment',
          { cardId: 'c1', attachmentId: 'file1', destPath },
          'network'
        );
        assert.equal(await readFile(destPath, 'utf8'), 'previous');
        assert.deepEqual(await readdir(folder), ['previous.txt']);
      } finally {
        config.timeoutMs = 30_000;
        await rm(folder, { recursive: true, force: true });
      }
    },
    'buffered EOF abort reader setup failure and stalled cancellation never publish': async (h) => {
      const folder = await mkdtemp(join(tmpdir(), 'chimedeck-reader-test-'));
      const destPath = join(folder, 'previous.txt');
      const fetchOriginal = globalThis.fetch;
      try {
        await writeFile(destPath, 'previous');
        config.timeoutMs = 25;
        h.respond(() => json({ data: [row] }));
        for (const mode of ['buffered', 'eof', 'reader', 'setup']) {
          let readCount = 0;
          globalThis.fetch = Object.assign(
            async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
              const url =
                typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
              if (!url.endsWith('/view')) return fetchOriginal(input, init);
              const response = new Response('hello', { headers: { 'Content-Type': 'text/plain' } });
              Object.defineProperty(response.body, 'getReader', {
                value: () => {
                  if (mode === 'reader') throw new Error('synthetic reader setup failure');
                  return {
                    async read() {
                      if (mode === 'buffered' || readCount++ > 0) {
                        await new Promise((accept) => setTimeout(accept, 80));
                        return {
                          done: mode !== 'buffered',
                          value: new TextEncoder().encode('hello'),
                        };
                      }
                      return { done: false, value: new TextEncoder().encode('hello') };
                    },
                    cancel() {
                      return new Promise(() => {});
                    },
                  };
                },
              });
              return response;
            },
            { preconnect: fetchOriginal.preconnect }
          );
          if (mode === 'setup') await writeFile(join(folder, 'parent-file'), 'parent');
          const result = await Promise.race([
            h.call('download_attachment', {
              cardId: 'c1',
              attachmentId: 'file1',
              destPath: mode === 'setup' ? join(folder, 'parent-file', 'output') : destPath,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => {
                reject(new Error('Cancellation blocked result'));
              }, 500)
            ),
          ]);
          assert.equal(result.isError, true);
          assert.equal(await readFile(destPath, 'utf8'), 'previous');
          assert.deepEqual(
            (await readdir(folder)).sort(),
            mode === 'setup' ? ['parent-file', 'previous.txt'] : ['previous.txt']
          );
        }
      } finally {
        globalThis.fetch = fetchOriginal;
        config.timeoutMs = 30_000;
        await rm(folder, { recursive: true, force: true });
      }
    },
    'relative destinations reject before HTTP or filesystem mutation': async (h) => {
      h.respond(() => json({ data: [row] }));
      for (const destPath of ['report.pdf', '../report.pdf', '~/report.pdf']) {
        assert.equal(
          (await h.call('download_attachment', { cardId: 'c1', attachmentId: 'file1', destPath }))
            .isError,
          true
        );
        assert.equal(h.requests.length, 0);
      }
    },
    'slow byte progress continues beyond the setup deadline': async (h) => {
      const folder = await mkdtemp(join(tmpdir(), 'chimedeck-progress-test-'));
      const destPath = join(folder, 'output.txt');
      try {
        config.timeoutMs = 80;
        h.respond(({ path }) =>
          path.endsWith('/view')
            ? new Response(
                new ReadableStream({
                  async pull(controller) {
                    await new Promise((accept) => setTimeout(accept, 20));
                    if (count++ < 8) controller.enqueue(new Uint8Array([65]));
                    else controller.close();
                  },
                }),
                { headers: { 'Content-Type': 'text/plain' } }
              )
            : json({ data: [{ ...row, size_bytes: 8 }] })
        );
        let count = 0;
        const started = performance.now();
        const result = await h.call('download_attachment', {
          cardId: 'c1',
          attachmentId: 'file1',
          destPath,
        });
        assert.equal(result.isError, false);
        assert.ok(performance.now() - started > 80);
        assert.equal(await readFile(destPath, 'utf8'), 'AAAAAAAA');
        assert.deepEqual(await readdir(folder), ['output.txt']);
      } finally {
        config.timeoutMs = 30_000;
        await rm(folder, { recursive: true, force: true });
      }
    },
    'local streaming exceeds the hosted 10 MiB cap without binary context': async (h) => {
      const folder = await mkdtemp(join(tmpdir(), 'chimedeck-large-test-'));
      const size = 10 * 1024 * 1024 + 4096;
      const path = join(folder, 'large.bin');
      try {
        h.respond(({ path }) => {
          if (!path.endsWith('/view'))
            return json({
              data: [{ ...row, size_bytes: size, content_type: 'application/octet-stream' }],
            });
          let remaining = size;
          return new Response(
            new ReadableStream({
              pull(controller) {
                if (!remaining) {
                  controller.close();
                  return;
                }
                const length = Math.min(65536, remaining);
                controller.enqueue(new Uint8Array(length));
                remaining -= length;
              },
            }),
            { headers: { 'Content-Type': 'application/octet-stream' } }
          );
        });
        const result = await h.call('download_attachment', {
          cardId: 'c1',
          attachmentId: 'file1',
          destPath: path,
        });
        assert.equal(result.isError, false);
        assert.equal(result.result.content.length, 1);
        assert.ok(result.text.length < 512);
        assert.equal((await stat(path)).size, size);
        assert.deepEqual(await readdir(folder), ['large.bin']);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    'body timeout cleans exclusive temporary file and preserves previous destination': async (
      h
    ) => {
      const folder = await mkdtemp(join(tmpdir(), 'chimedeck-timeout-test-'));
      const path = join(folder, 'previous.txt');
      try {
        await writeFile(path, 'previous');
        config.timeoutMs = 25;
        h.respond(({ path }) =>
          path.endsWith('/view')
            ? new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode('he'));
                    setTimeout(() => {
                      try {
                        controller.enqueue(new TextEncoder().encode('llo'));
                        controller.close();
                      } catch {
                        /* Client intentionally aborted the fixture stream. */
                      }
                    }, 100);
                  },
                }),
                { headers: { 'Content-Type': 'text/plain' } }
              )
            : json({ data: [row] })
        );
        await h.fail(
          'download_attachment',
          { cardId: 'c1', attachmentId: 'file1', destPath: path },
          'download-failed'
        );
        assert.equal(await readFile(path, 'utf8'), 'previous');
        assert.deepEqual(await readdir(folder), ['previous.txt']);
      } finally {
        config.timeoutMs = 30_000;
        await rm(folder, { recursive: true, force: true });
      }
    },
    'stdio discovery requires destPath and marks filesystem effects': async (h) => {
      const tool = h.tools.find((tool) => tool.name === 'download_attachment');
      assert.ok(tool);
      assert.ok(tool);
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.equal(tool.annotations.destructiveHint, true);
      assert.ok(tool.inputSchema.required?.includes('destPath'));
      h.respond(() => json({ data: [row] }));
      assert.equal(
        (await h.call('download_attachment', { cardId: 'c1', attachmentId: 'file1' })).isError,
        true
      );
      assert.equal(h.requests.length, 0);
    },
    'atomic streamed stdio download returns small metadata and replaces only after validation':
      async (h) => {
        const folder = await mkdtemp(join(tmpdir(), 'chimedeck-disk-test-'));
        try {
          const path = join(folder, 'nested', 'output.txt');
          h.respond(({ path }) =>
            path.endsWith('/view')
              ? new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(new TextEncoder().encode('he'));
                      controller.enqueue(new TextEncoder().encode('llo'));
                      controller.close();
                    },
                  }),
                  { headers: { 'Content-Type': 'text/plain' } }
                )
              : json({ data: [row] })
          );
          const result = await h.call('download_attachment', {
            cardId: 'c1',
            attachmentId: 'file1',
            destPath: path,
          });
          assert.equal(result.isError, false);
          assert.equal(result.result.content.length, 1);
          const meta = JSON.parse(result.text) as Record<string, unknown>;
          assert.equal(meta.path, path);
          assert.equal(meta.size_bytes, 5);
          assert.equal(meta.verified, true);
          assert.equal(await readFile(path, 'utf8'), 'hello');
          assert.deepEqual(await readdir(join(folder, 'nested')), ['output.txt']);
          await writeFile(path, 'previous');
          h.respond(({ path }) =>
            path.endsWith('/view')
              ? new Response('bad', { headers: { 'Content-Type': 'text/plain' } })
              : json({ data: [row] })
          );
          await h.fail(
            'download_attachment',
            { cardId: 'c1', attachmentId: 'file1', destPath: path },
            'size-mismatch'
          );
          assert.equal(await readFile(path, 'utf8'), 'previous');
          assert.deepEqual(await readdir(join(folder, 'nested')), ['output.txt']);
        } finally {
          await rm(folder, { recursive: true, force: true });
        }
      },
    'local file scope readiness redirect and denial do not write destination': async (h) => {
      const folder = await mkdtemp(join(tmpdir(), 'chimedeck-refusal-test-'));
      const destPath = join(folder, 'output.txt');
      const args = { cardId: 'c1', attachmentId: 'file1', destPath };
      try {
        for (const [entry, code] of [
          [{ ...row, type: 'LINK', external_url: 'https://external.invalid' }, 'not-a-file'],
          [{ ...row, status: 'UPLOADING' }, 'not-ready'],
          [{ ...row, id: 'foreign' }, 'not-in-card'],
        ] as const) {
          h.respond(() => json({ data: [entry] }));
          await h.fail('download_attachment', args, code);
          assert.equal(h.requests.length, 1);
        }
        h.respond(({ path }) =>
          path.endsWith('/view')
            ? new Response(null, { status: 302, headers: { Location: 'https://external.invalid' } })
            : json({ data: [row] })
        );
        await h.fail('download_attachment', args, 'http-302');
        h.respond(({ path }) =>
          path.endsWith('/view') ? apiError(403, 'forbidden') : json({ data: [row] })
        );
        await h.fail('download_attachment', args, 'http-403');
        h.respond(({ path }) =>
          path.endsWith('/view')
            ? new Response('hello', { headers: { 'Content-Type': 'Text/HTML; charset=UTF-8' } })
            : json({ data: [row] })
        );
        await h.fail('download_attachment', args, 'invalid-response');
        assert.deepEqual(await readdir(folder), []);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    'hosted discovery has no writable path and extra destPath cannot enable disk I/O': async (
      h
    ) => {
      const tool = h.tools.find((tool) => tool.name === 'download_attachment');
      assert.ok(tool);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, undefined);
      assert.equal(tool.inputSchema.properties?.destPath, undefined);
      const folder = await mkdtemp(join(tmpdir(), 'chimedeck-http-test-'));
      try {
        h.respond(({ path }) =>
          path.endsWith('/view')
            ? new Response('hello', { headers: { 'Content-Type': 'text/plain' } })
            : json({ data: [row] })
        );
        const result = await h.call('download_attachment', {
          cardId: 'c1',
          attachmentId: 'file1',
          destPath: join(folder, 'must-not-exist'),
        });
        // SDKs may discard or reject unknown args; neither may activate filesystem effects.
        if (!result.isError) assert.equal(result.result.content.length, 2);
        assert.deepEqual(await readdir(folder), []);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  }
);
