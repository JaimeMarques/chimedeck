// Playwright E2E tests for board member API flows (Sprint 78, Iteration 3)
// Covers: GET/POST/PATCH/DELETE /boards/:id/members, role/visibility logic

import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3000';

async function registerAndLogin(request: APIRequestContext, suffix: string) {
  const email = `bm-test-${suffix}-${randomUUID()}@example.com`;
  const password = 'TestPassword1!';
  const registered = await request.post(`${BASE_URL}/api/v1/auth/register`, {
    data: { email, password, name: `BM ${suffix}` },
  });
  expect(registered.status()).toBe(201);
  const loginRes = await request.post(`${BASE_URL}/api/v1/auth/token`, {
    data: { email, password },
  });
  expect(loginRes.status()).toBe(200);
  const body = await loginRes.json() as { data: { accessToken: string; user: { id: string } } };
  expect(body.data.accessToken).toEqual(expect.any(String));
  expect(body.data.user.id).toEqual(expect.any(String));
  return { token: body.data.accessToken, id: body.data.user.id, email };
}

async function createWorkspace(request: APIRequestContext, token: string) {
  const res = await request.post(`${BASE_URL}/api/v1/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: `WS-${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { id: string } };
  return body.data.id;
}

async function createBoard(request: APIRequestContext, token: string, workspaceId: string, visibility = 'PRIVATE') {
  const res = await request.post(`${BASE_URL}/api/v1/workspaces/${workspaceId}/boards`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: `Board-${randomUUID()}`, visibility },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { id: string } };
  return body.data.id;
}

test.describe('Board member API flows', () => {
  type Actor = Awaited<ReturnType<typeof registerAndLogin>>;
  let owner: Actor;
  let boardAdmin: Actor;
  let target: Actor;

  // Fresh workspaces per case, shared identities to stay below login limits.
  test.beforeAll(async ({ request }) => {
    owner = await registerAndLogin(request, 'owner');
    boardAdmin = await registerAndLogin(request, 'admin');
    target = await registerAndLogin(request, 'target');
  });

  async function addWorkspaceMember(request: APIRequestContext, wsId: string, actor: Actor) {
    const res = await request.post(`${BASE_URL}/api/v1/workspaces/${wsId}/members`, {
      headers: { Authorization: `Bearer ${owner.token}` },
      data: { email: actor.email, role: 'MEMBER' },
    });
    expect(res.status()).toBe(201);
    expect(await res.json()).toMatchObject({ data: { role: 'MEMBER', userId: actor.id } });
  }

  async function members(request: APIRequestContext, boardId: string) {
    const res = await request.get(`${BASE_URL}/api/v1/boards/${boardId}/members`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status()).toBe(200);
    return (await res.json() as { data: Array<{ user_id: string; role: string }> }).data;
  }

  test('GET /boards/:id/members returns explicit board members', async ({ request }) => {
    const { token } = owner;
    const wsId = await createWorkspace(request, token);
    const boardId = await createBoard(request, token, wsId);
    await addWorkspaceMember(request, wsId, target);
    const added = await request.post(`${BASE_URL}/api/v1/boards/${boardId}/members`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { userId: target.id, role: 'MEMBER' },
    });
    expect(added.status()).toBe(201);
    // List members
    const res = await request.get(`${BASE_URL}/api/v1/boards/${boardId}/members`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: Array<{ user_id: string }> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((m) => m.user_id === target.id)).toBe(true);
  });

  test('POST /boards/:id/members rejects a duplicate add; PATCH changes the role', async ({ request }) => {
    const { token } = owner;
    const wsId = await createWorkspace(request, token);
    const boardId = await createBoard(request, token, wsId);
    await addWorkspaceMember(request, wsId, target);
    const created = await request.post(`${BASE_URL}/api/v1/boards/${boardId}/members`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { userId: target.id, role: 'MEMBER' },
    });
    expect(created.status()).toBe(201);
    // Re-adding is a conflict, not a role change — it must not rewrite the role,
    // which is how a board's last ADMIN could previously be demoted.
    const duplicate = await request.post(`${BASE_URL}/api/v1/boards/${boardId}/members`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { userId: target.id, role: 'ADMIN' },
    });
    expect(duplicate.status()).toBe(409);
    expect(await duplicate.json()).toMatchObject({ name: 'board-member-exists' });
    expect((await members(request, boardId)).find((m) => m.user_id === target.id)?.role).toBe('MEMBER');
    // Role changes go through PATCH, which the caller above is authorized for.
    const patched = await request.patch(`${BASE_URL}/api/v1/boards/${boardId}/members/${target.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { role: 'ADMIN' },
    });
    expect(patched.status()).toBe(200);
    const body = await patched.json() as { data: { role: string } };
    expect(body.data.role).toBe('ADMIN');
    expect((await members(request, boardId)).find((m) => m.user_id === target.id)?.role).toBe('ADMIN');
  });

  test('workspace MEMBER needs explicit board ADMIN to PATCH another member', async ({ request }) => {
    const wsId = await createWorkspace(request, owner.token);
    const boardId = await createBoard(request, owner.token, wsId);
    await addWorkspaceMember(request, wsId, boardAdmin);
    await addWorkspaceMember(request, wsId, target);
    for (const actor of [boardAdmin, target]) {
      const added = await request.post(`${BASE_URL}/api/v1/boards/${boardId}/members`, {
        headers: { Authorization: `Bearer ${owner.token}` },
        data: { userId: actor.id, role: 'MEMBER' },
      });
      expect(added.status()).toBe(201);
    }
    const url = `${BASE_URL}/api/v1/boards/${boardId}/members/${target.id}`;
    const denied = await request.patch(url, {
      headers: { Authorization: `Bearer ${boardAdmin.token}` }, data: { role: 'ADMIN' },
    });
    expect(denied.status()).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: 'insufficient-role' } });
    expect((await members(request, boardId)).find((m) => m.user_id === target.id)?.role).toBe('MEMBER');
    const promoted = await request.patch(`${BASE_URL}/api/v1/boards/${boardId}/members/${boardAdmin.id}`, {
      headers: { Authorization: `Bearer ${owner.token}` }, data: { role: 'ADMIN' },
    });
    expect(promoted.status()).toBe(200);
    // Same workspace MEMBER, now explicit board ADMIN: an OWNER would pass
    // even with the authorization fallback deleted.
    const allowed = await request.patch(url, {
      headers: { Authorization: `Bearer ${boardAdmin.token}` }, data: { role: 'ADMIN' },
    });
    expect(allowed.status()).toBe(200);
    expect((await members(request, boardId)).find((m) => m.user_id === target.id)?.role).toBe('ADMIN');
  });

  test('PATCH /boards/:id/members/:userId changes role, rejects demotion of last ADMIN', async ({ request }) => {
    const { token } = owner;
    const wsId = await createWorkspace(request, token);
    const boardId = await createBoard(request, token, wsId);
    // Try demoting last ADMIN
    const res = await request.patch(`${BASE_URL}/api/v1/boards/${boardId}/members/${owner.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { role: 'MEMBER' },
    });
    expect(res.status()).toBe(409);
    expect(await res.json()).toMatchObject({ name: 'last-board-admin' });
  });

  test('DELETE /boards/:id/members/:userId removes member, rejects removal of last ADMIN', async ({ request }) => {
    const { token } = owner;
    const wsId = await createWorkspace(request, token);
    const boardId = await createBoard(request, token, wsId);
    // Try removing last ADMIN
    const res = await request.delete(`${BASE_URL}/api/v1/boards/${boardId}/members/${owner.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(409);
    expect(await res.json()).toMatchObject({ name: 'last-board-admin' });
  });

  test('workspace owner can list a PUBLIC board', async ({ request }) => {
    const { token } = owner;
    const wsId = await createWorkspace(request, token);
    const boardId = await createBoard(request, token, wsId, 'PUBLIC');

    const res = await request.get(`${BASE_URL}/api/v1/workspaces/${wsId}/boards`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: Array<{ id: string }> };
    expect(body.data.some((b) => b.id === boardId)).toBe(true);
  });
});
