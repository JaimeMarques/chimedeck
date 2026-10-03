import { strict as assert } from 'node:assert';
import { basename } from 'node:path';
import { expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config';

// Shared MCP contract harness: a real MCP client talks to the tools under
// test, which call a local HTTP REST fixture that records every request.
//
//   defineToolScenarios(import.meta, registerX, { scenario: async (h) => { ... } });
//
// [why] Each scenario runs in its own Bun process. Other *.test.ts files
// mock.module('../apiClient') and Bun never restores module mocks between files.

export const TOKEN = 'caller-token-never-echo';

export interface RecordedRequest {
  method: string;
  path: string; // pathname + search
  body: unknown; // parsed JSON, undefined when empty
  authorization: string | null;
}
type Responder = (request: RecordedRequest) => Response | Promise<Response>;
type Register = (server: McpServer, token: string) => void;
type Scenario = (h: Harness) => Promise<void> | void;

export interface Harness {
  tools: Tool[];
  requests: RecordedRequest[];
  // Replace the REST responder and clear recorded requests.
  respond(responder: Responder): void;
  call(name: string, args?: Record<string, unknown>): Promise<{ result: CallToolResult; text: string; isError: boolean }>;
  // Call, assert success, return the parsed JSON text.
  ok(name: string, args?: Record<string, unknown>): Promise<unknown>;
  // Call, assert `Error: <code>`.
  fail(name: string, args: Record<string, unknown> | undefined, code: string): Promise<void>;
}

export const json = (data: unknown, status = 200) => Response.json(data, { status });
export const html = () => new Response('<!doctype html><html></html>', { headers: { 'Content-Type': 'text/html' } });
// Error body carries the token so every error path also proves it is not echoed.
export const apiError = (status: number, name?: string) =>
  Response.json({ ...(name ? { name } : {}), error: { message: TOKEN } }, { status });

// The failure modes every single-GET tool must reject.
export async function expectReadErrors(h: Harness, name: string, args?: Record<string, unknown>): Promise<void> {
  const cases: Array<[() => Response, string]> = [
    [() => apiError(404), 'http-404'],
    [() => apiError(403, 'forbidden'), 'forbidden'],
    [() => apiError(400, `bad ${TOKEN}`), 'api-error'],
    [() => json(null), 'invalid-response'],
    [html, 'invalid-response'],
    [() => json({ data: TOKEN }), 'invalid-response'],
  ];
  for (const [response, code] of cases) {
    h.respond(response);
    await h.fail(name, args, code);
  }
}

export function expectAnnotations(h: Harness, names: string[], annotations: Tool['annotations']): void {
  for (const name of names) {
    const tool = h.tools.find((entry) => entry.name === name);
    assert.ok(tool, `${name} not registered`);
    for (const [key, value] of Object.entries(annotations ?? {})) {
      assert.equal((tool.annotations as Record<string, unknown> | undefined)?.[key], value, `${name} ${key}`);
    }
  }
}

async function runScenario(register: Register, run: Scenario): Promise<void> {
  const requests: RecordedRequest[] = [];
  let responder: Responder = () => Response.json({ error: { message: 'no responder' } }, { status: 599 });
  const rest = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const raw = await request.text();
      const recorded = {
        method: request.method,
        path: url.pathname + url.search,
        body: raw ? JSON.parse(raw) as unknown : undefined,
        authorization: request.headers.get('authorization'),
      };
      requests.push(recorded);
      return responder(recorded);
    },
  });
  config.apiUrl = rest.url.origin;
  config.token = 'wrong-environment-token';
  const server = new McpServer({ name: 'tool-test', version: '1' });
  register(server, TOKEN);
  const client = new Client({ name: 'tool-test-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const call: Harness['call'] = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }) as CallToolResult;
      const first = result.content[0];
      const text = first?.type === 'text' ? first.text : '';
      assert.ok(!JSON.stringify(result).includes(TOKEN), `${name} leaked the token`);
      return { result, text, isError: result.isError === true };
    };
    await run({
      tools: (await client.listTools()).tools,
      requests,
      respond(next) { responder = next; requests.length = 0; },
      call,
      async ok(name, args) {
        const { text, isError } = await call(name, args);
        assert.equal(isError, false, `${name} failed: ${text}`);
        return JSON.parse(text) as unknown;
      },
      async fail(name, args, code) {
        const { text, isError } = await call(name, args);
        assert.equal(isError, true, `${name} succeeded: ${text}`);
        assert.equal(text, `Error: ${code}`);
      },
    });
    assert.ok(requests.every((entry) => entry.authorization === `Bearer ${TOKEN}`), 'caller token not used');
  } finally {
    await client.close();
    await server.close();
    await rest.stop(true);
  }
}

// In `bun test`: one test per scenario, each spawning this file with --scenario.
// In the child: run that scenario and print PASS.
export function defineToolScenarios(
  meta: ImportMeta,
  register: Register,
  scenarios: Record<string, Scenario>,
): void {
  const flag = Bun.argv.indexOf('--scenario');
  if (flag === -1) {
    for (const name of Object.keys(scenarios)) {
      test(`${basename(meta.path)}: ${name}`, () => {
        const child = Bun.spawnSync([process.execPath, meta.path, '--scenario', name], { stdout: 'pipe', stderr: 'pipe' });
        expect(child.stderr.toString()).toBe('');
        expect(child.exitCode).toBe(0);
        expect(child.stdout.toString()).toContain(`PASS ${name}`);
      });
    }
    return;
  }
  const name = Bun.argv[flag + 1] ?? '';
  const run = scenarios[name];
  if (!run) throw new Error(`unknown scenario ${name}`);
  void runScenario(register, run).then(() => { console.info(`PASS ${name}`); });
}
