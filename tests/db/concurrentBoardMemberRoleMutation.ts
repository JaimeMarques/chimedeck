// PostgreSQL concurrency regression for the last-board-ADMIN invariant.
//
// The handlers must serialize ADMIN demotions/removals per board. Without the
// shared mutation lock, two requests can both observe two ADMIN rows, both
// succeed, and leave the board with no administrator.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { db } from '../../server/common/db';
import { handleRemoveBoardMember } from '../../server/extensions/board/api/members/remove';
import { handleUpdateBoardMember } from '../../server/extensions/board/api/members/update';
import { handleAddMember } from '../../server/extensions/workspace/api/members/add';
import { lockWorkspaceMembershipMutations } from '../../server/extensions/workspace/api/members/lock';
import { boardsRouter } from '../../server/extensions/trelloCompat/api/boards/index';
import { organizationsRouter } from '../../server/extensions/trelloCompat/api/organizations/index';

const LOCK_NAMESPACE = 'board-members';

async function createApiToken(userId: string): Promise<string> {
  const token = `hf_${randomUUID()}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  await db('api_tokens').insert({
    id: randomUUID(),
    user_id: userId,
    name: 'board-member-concurrency-regression',
    token_hash: tokenHash,
    token_prefix: token.slice(0, 10),
  });
  return token;
}

type Scenario = 'demote' | 'remove';

type Fixture = {
  workspaceId: string;
  boardId: string;
  actorId: string;
  adminIds: [string, string];
};

function scopedRequest(
  fixture: Fixture,
  method: 'PATCH' | 'DELETE',
  options: { actorId?: string; callerRole?: string; role?: 'ADMIN' | 'MEMBER' } = {}
): Request {
  const init: RequestInit = { method };
  if (method === 'PATCH') {
    init.body = JSON.stringify({ role: options.role ?? 'MEMBER' });
    init.headers = { 'content-type': 'application/json' };
  }
  const req = new Request(
    `https://example.test/api/v1/boards/${fixture.boardId}/members/target`,
    init
  );

  return Object.assign(req, {
    currentUser: { id: options.actorId ?? fixture.actorId },
    workspaceId: fixture.workspaceId,
    callerRole: options.callerRole ?? 'OWNER',
    board: { id: fixture.boardId, workspace_id: fixture.workspaceId, visibility: 'PRIVATE' },
  });
}

function trelloMemberRequest(
  fixture: Fixture,
  method: 'PUT' | 'DELETE',
  targetUserId: string,
  actorId = fixture.actorId
): Parameters<typeof boardsRouter>[0] {
  const init: RequestInit = { method };
  if (method === 'PUT') {
    init.body = JSON.stringify({ type: 'normal' });
    init.headers = { 'content-type': 'application/json' };
  }
  return Object.assign(
    new Request(
      `https://example.test/trello/1/boards/${fixture.boardId}/members/${targetUserId}`,
      init
    ),
    { currentUser: { id: actorId, email: `${actorId}@example.test` } }
  );
}

async function seedFixture(label: string): Promise<Fixture> {
  const fixture: Fixture = {
    workspaceId: `ws-${randomUUID()}`,
    boardId: `board-${randomUUID()}`,
    actorId: `actor-${randomUUID()}`,
    adminIds: [`admin-${randomUUID()}`, `admin-${randomUUID()}`],
  };

  await db('users').insert([
    {
      id: fixture.actorId,
      email: `${fixture.actorId}@example.test`,
      name: 'Actor',
      email_verified: true,
    },
    ...fixture.adminIds.map((id, index) => ({
      id,
      email: `${id}@example.test`,
      name: `Admin ${String(index + 1)}`,
      email_verified: true,
    })),
  ]);
  await db('workspaces').insert({
    id: fixture.workspaceId,
    name: `last-admin-${label}`,
    owner_id: fixture.actorId,
  });
  await db('memberships').insert([
    { user_id: fixture.actorId, workspace_id: fixture.workspaceId, role: 'OWNER' },
    ...fixture.adminIds.map((userId) => ({
      user_id: userId,
      workspace_id: fixture.workspaceId,
      role: 'MEMBER',
    })),
  ]);
  await db('boards').insert({
    id: fixture.boardId,
    workspace_id: fixture.workspaceId,
    title: `last-admin-${label}`,
    visibility: 'PRIVATE',
    short_id: randomUUID().slice(0, 8),
  });
  await db('board_members').insert(
    fixture.adminIds.map((userId) => ({
      id: randomUUID(),
      board_id: fixture.boardId,
      user_id: userId,
      role: 'ADMIN',
    }))
  );

  return fixture;
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await db('board_guest_access').where({ board_id: fixture.boardId }).delete();
  await db('board_members').where({ board_id: fixture.boardId }).delete();
  await db('boards').where({ id: fixture.boardId }).delete();
  await db('memberships').where({ workspace_id: fixture.workspaceId }).delete();
  await db('workspaces').where({ id: fixture.workspaceId }).delete();
  await db('users')
    .whereIn('id', [fixture.actorId, ...fixture.adminIds])
    .delete();
}

async function waitUntilBothRequestsReachBarrier(): Promise<void> {
  const deadline = Date.now() + 10_000;

  for (;;) {
    const locks = await db.raw<{
      rows: Array<{ advisory_waiters: string; table_waiters: string }>;
    }>(`
      SELECT
        count(*) FILTER (
          WHERE locktype = 'advisory'
            AND mode = 'ExclusiveLock'
            AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        ) AS advisory_waiters,
        count(*) FILTER (
          WHERE relation = 'board_members'::regclass
            AND mode = 'RowExclusiveLock'
            AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        ) AS table_waiters
      FROM pg_locks
    `);
    const row = locks.rows[0];
    if (Number(row?.advisory_waiters) >= 2 || Number(row?.table_waiters) >= 2) return;
    if (Date.now() >= deadline)
      throw new Error('Both requests did not reach the concurrency barrier');
    await Bun.sleep(20);
  }
}

async function runScenario(scenario: Scenario | 'mixed'): Promise<void> {
  const fixture = await seedFixture(scenario);
  const barrier = await db.transaction();
  let pending: Promise<PromiseSettledResult<Response>[]> | undefined;
  let outcomes: PromiseSettledResult<Response>[] = [];

  try {
    // Fixed handlers wait on the per-board advisory lock. The vulnerable
    // handlers do not know that lock, so SHARE instead lets both count two
    // ADMINs and blocks both writes until the test releases the barrier.
    await barrier.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
      `${LOCK_NAMESPACE}:${fixture.boardId}`,
    ]);
    await barrier.raw('LOCK TABLE board_members IN SHARE MODE');

    const operations = fixture.adminIds.map((userId) => {
      if (scenario === 'mixed' && userId === fixture.adminIds[1]) {
        // Both adapters must use the same lock, not merely serialize themselves.
        return boardsRouter(
          trelloMemberRequest(fixture, 'DELETE', userId),
          `/boards/${fixture.boardId}/members/${userId}`
        ).then((response) => {
          assert.ok(response, 'the Trello member route must handle this request');
          return response;
        });
      }
      if (scenario !== 'remove') {
        return handleUpdateBoardMember(scopedRequest(fixture, 'PATCH'), fixture.boardId, userId);
      }
      return handleRemoveBoardMember(scopedRequest(fixture, 'DELETE'), fixture.boardId, userId);
    });
    pending = Promise.allSettled(operations);
    await waitUntilBothRequestsReachBarrier();
  } finally {
    await barrier.rollback();
    if (pending) outcomes = await pending;
  }

  try {
    const responses = outcomes.map((outcome) => {
      if (outcome.status === 'rejected') throw outcome.reason;
      return outcome.value;
    });
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    assert.deepEqual(
      statuses,
      [200, 409],
      `${scenario}: exactly one ADMIN-removing request must be rejected`
    );

    const remaining = await db('board_members')
      .where({ board_id: fixture.boardId, role: 'ADMIN' })
      .count('id as count')
      .first();
    assert.equal(
      Number((remaining as { count?: string | number } | undefined)?.count ?? 0),
      1,
      `${scenario}: one board ADMIN must remain`
    );
    console.info(`PASS  concurrent ${scenario} requests preserve one board ADMIN`);
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runStaleAdminScenario(): Promise<void> {
  const fixture = await seedFixture('stale-admin');
  try {
    await db('memberships')
      .where({ workspace_id: fixture.workspaceId, user_id: fixture.adminIds[0] })
      .update({ role: 'GUEST' });
    await db('board_guest_access').insert({
      id: randomUUID(),
      board_id: fixture.boardId,
      user_id: fixture.adminIds[0],
      guest_type: 'MEMBER',
      granted_by: fixture.actorId,
    });

    const staleGuestResponse = await handleUpdateBoardMember(
      scopedRequest(fixture, 'PATCH', {
        actorId: fixture.adminIds[0],
        callerRole: 'GUEST',
        role: 'ADMIN',
      }),
      fixture.boardId,
      fixture.adminIds[1]
    );
    assert.equal(staleGuestResponse.status, 403, 'a GUEST must not reuse a stale board ADMIN row');

    const cleanupResponse = await handleRemoveBoardMember(
      scopedRequest(fixture, 'DELETE'),
      fixture.boardId,
      fixture.adminIds[0]
    );
    assert.equal(
      cleanupResponse.status,
      200,
      'deleting an ineligible stale ADMIN must not be rejected as deleting the last eligible ADMIN'
    );

    const response = await handleUpdateBoardMember(
      scopedRequest(fixture, 'PATCH'),
      fixture.boardId,
      fixture.adminIds[1]
    );
    assert.equal(response.status, 409, 'a stale GUEST admin must not satisfy the last-admin guard');
    console.info(
      'PASS  stale GUEST admin is denied, removable, and excluded from last-admin count'
    );
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runStaleWorkspaceAuthorityScenario(): Promise<void> {
  const fixture = await seedFixture('stale-workspace-authority');
  try {
    await db('memberships')
      .where({ workspace_id: fixture.workspaceId, user_id: fixture.actorId })
      .update({ role: 'MEMBER' });

    const response = await handleUpdateBoardMember(
      scopedRequest(fixture, 'PATCH', { callerRole: 'OWNER', role: 'MEMBER' }),
      fixture.boardId,
      fixture.adminIds[0]
    );
    assert.equal(
      response.status,
      403,
      'a cached OWNER role must not authorize a mutation after database demotion'
    );
    console.info('PASS  board mutation rejects stale cached workspace authority');
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runConcurrentWorkspaceAuthorityRevocationScenario(): Promise<void> {
  const fixture = await seedFixture('concurrent-workspace-authority-revocation');
  const barrier = await db.transaction();
  let responsePromise: Promise<Response> | undefined;
  try {
    await barrier.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
      `workspace-memberships:${fixture.workspaceId}`,
    ]);
    responsePromise = handleUpdateBoardMember(
      scopedRequest(fixture, 'PATCH', { callerRole: 'OWNER', role: 'MEMBER' }),
      fixture.boardId,
      fixture.adminIds[0]
    );
    await Promise.race([
      responsePromise.then(() => undefined),
      (async () => {
        const deadline = Date.now() + 10000;
        for (;;) {
          const waiting = await db.raw<{ rows: Array<{ count: string }> }>(`
            SELECT count(*) FROM pg_locks
            WHERE locktype = 'advisory'
              AND mode = 'ExclusiveLock' AND NOT granted
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          `);
          if (Number(waiting.rows[0]?.count) >= 1) return;
          if (Date.now() >= deadline)
            throw new Error('Workspace-authority mutation did not reach barrier');
          await Bun.sleep(20);
        }
      })(),
    ]);

    await barrier('memberships')
      .where({ workspace_id: fixture.workspaceId, user_id: fixture.actorId })
      .update({ role: 'MEMBER' });
  } finally {
    await barrier.commit();
  }

  try {
    const response = await responsePromise;
    assert.equal(
      response.status,
      403,
      'a mutation queued behind workspace-role revocation must re-authorize the actor'
    );
    console.info('PASS  workspace-role revocation wins over queued board mutation');
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runTrelloWorkspaceRemovalScenario(): Promise<void> {
  const fixture = await seedFixture('trello-workspace-remove');
  try {
    await db('memberships')
      .where({ workspace_id: fixture.workspaceId, user_id: fixture.adminIds[0] })
      .update({ role: 'GUEST' });

    const req = Object.assign(
      new Request(
        `https://example.test/trello/1/organizations/${fixture.workspaceId}/members/${fixture.adminIds[1]}`,
        { method: 'DELETE' }
      ),
      { currentUser: { id: fixture.actorId, email: `${fixture.actorId}@example.test` } }
    );
    const response = await organizationsRouter(
      req,
      `/organizations/${fixture.workspaceId}/members/${fixture.adminIds[1]}`
    );
    assert.equal(
      response?.status,
      409,
      'Trello workspace removal must preserve the last eligible board ADMIN'
    );

    const membership = await db<{ user_id: string; workspace_id: string }>('memberships')
      .where({ workspace_id: fixture.workspaceId, user_id: fixture.adminIds[1] })
      .first();
    assert.ok(membership, 'rejected Trello workspace removal must retain the membership');
    console.info('PASS  Trello workspace removal preserves the eligible-admin invariant');
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runTrelloInvariantScenario(scenario: Scenario): Promise<void> {
  const fixture = await seedFixture(`trello-${scenario}`);
  const barrier = await db.transaction();
  let pending: Promise<PromiseSettledResult<Response | null>[]> | undefined;
  let outcomes: PromiseSettledResult<Response | null>[] = [];
  try {
    await barrier.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
      `workspace-memberships:${fixture.workspaceId}`,
    ]);
    await barrier.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
      `${LOCK_NAMESPACE}:${fixture.boardId}`,
    ]);
    await barrier.raw('LOCK TABLE board_members IN SHARE MODE');

    const method = scenario === 'demote' ? 'PUT' : 'DELETE';
    pending = Promise.allSettled(
      fixture.adminIds.map((userId) =>
        boardsRouter(
          trelloMemberRequest(fixture, method, userId),
          `/boards/${fixture.boardId}/members/${userId}`
        )
      )
    );
    await waitUntilBothRequestsReachBarrier();
  } finally {
    await barrier.rollback();
    if (pending) outcomes = await pending;
  }

  try {
    const responses = outcomes.map((outcome) => {
      if (outcome.status === 'rejected') throw outcome.reason;
      assert.ok(outcome.value);
      return outcome.value;
    });
    assert.deepEqual(
      responses.map((response) => response.status).sort((a, b) => a - b),
      [200, 409],
      `concurrent Trello ${scenario} must reject exactly one ADMIN-removing request`
    );
    const eligibleAdmins = await db('board_members as bm')
      .join('memberships as m', function joinMembership() {
        this.on('m.user_id', '=', 'bm.user_id').andOnVal(
          'm.workspace_id',
          '=',
          fixture.workspaceId
        );
      })
      .where({ 'bm.board_id': fixture.boardId, 'bm.role': 'ADMIN' })
      .whereNot('m.role', 'GUEST')
      .countDistinct('bm.user_id as count')
      .first();
    assert.equal(Number(eligibleAdmins?.count ?? 0), 1, 'one eligible ADMIN must remain');
    console.info(`PASS  concurrent Trello-compatible ${scenario} preserves one board ADMIN`);
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runTrelloGuestAuthorizationScenario(): Promise<void> {
  const fixture = await seedFixture('trello-guest-auth');
  try {
    await db('memberships')
      .where({ workspace_id: fixture.workspaceId, user_id: fixture.actorId })
      .update({ role: 'GUEST' });
    await db('board_members').insert({
      id: randomUUID(),
      board_id: fixture.boardId,
      user_id: fixture.actorId,
      role: 'ADMIN',
    });
    await db('board_guest_access').insert({
      id: randomUUID(),
      board_id: fixture.boardId,
      user_id: fixture.actorId,
      guest_type: 'MEMBER',
      granted_by: fixture.adminIds[0],
    });

    const response = await boardsRouter(
      trelloMemberRequest(fixture, 'DELETE', fixture.adminIds[0]),
      `/boards/${fixture.boardId}/members/${fixture.adminIds[0]}`
    );
    assert.equal(response?.status, 401, 'a GUEST must not reuse a stale board ADMIN row');
    console.info('PASS  Trello-compatible member mutation rejects stale GUEST admin');
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runTrelloStaleAdminCleanupScenario(): Promise<void> {
  const fixture = await seedFixture('trello-stale-admin-cleanup');
  try {
    await db('memberships')
      .where({ workspace_id: fixture.workspaceId, user_id: fixture.adminIds[0] })
      .update({ role: 'GUEST' });
    await db('board_guest_access').insert({
      id: randomUUID(),
      board_id: fixture.boardId,
      user_id: fixture.adminIds[0],
      guest_type: 'MEMBER',
      granted_by: fixture.actorId,
    });

    const response = await boardsRouter(
      trelloMemberRequest(fixture, 'DELETE', fixture.adminIds[0]),
      `/boards/${fixture.boardId}/members/${fixture.adminIds[0]}`
    );
    assert.equal(response?.status, 200, 'Trello must allow cleanup of an ineligible stale ADMIN');
    const staleRow = await db<{ board_id: string; user_id: string }>('board_members')
      .where({ board_id: fixture.boardId, user_id: fixture.adminIds[0] })
      .first();
    assert.equal(staleRow, undefined, 'Trello stale ADMIN cleanup must delete the board row');
    console.info('PASS  Trello-compatible delete cleans an ineligible stale ADMIN');
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runAuthorizationRevocationScenario(): Promise<void> {
  const fixture = await seedFixture('authorization-revocation');
  const barrier = await db.transaction();
  let pending: Promise<PromiseSettledResult<Response>[]> | undefined;
  let outcomes: PromiseSettledResult<Response>[] = [];

  try {
    await barrier.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
      `${LOCK_NAMESPACE}:${fixture.boardId}`,
    ]);
    const adminId = fixture.adminIds[0];
    const ownerDemotion = handleUpdateBoardMember(
      scopedRequest(fixture, 'PATCH'),
      fixture.boardId,
      adminId
    );

    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await db.raw<{ rows: Array<{ count: string }> }>(`
        SELECT count(*) FROM pg_locks
        WHERE locktype = 'advisory'
          AND mode = 'ExclusiveLock'
          AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `);
      if (Number(waiting.rows[0]?.count) >= 1) break;
      if (Date.now() >= deadline) throw new Error('Owner demotion did not reach the lock barrier');
      await Bun.sleep(20);
    }

    const staleAdminMutation = handleUpdateBoardMember(
      scopedRequest(fixture, 'PATCH', {
        actorId: adminId,
        callerRole: 'MEMBER',
        role: 'ADMIN',
      }),
      fixture.boardId,
      adminId
    );
    pending = Promise.allSettled([ownerDemotion, staleAdminMutation]);
    await waitUntilBothRequestsReachBarrier();
  } finally {
    await barrier.rollback();
    if (pending) outcomes = await pending;
  }

  try {
    const responses = outcomes.map((outcome) => {
      if (outcome.status === 'rejected') throw outcome.reason;
      return outcome.value;
    });
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 403],
      'a board admin demoted ahead of its queued mutation must be re-authorized and denied'
    );
    console.info('PASS  queued mutation re-authorizes board ADMIN after acquiring the lock');
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runGuestPromotionLockOrderScenario(): Promise<void> {
  const fixture = await seedFixture('guest-promotion-lock-order');
  const targetId = fixture.adminIds[1];
  const targetEmail = `${targetId}@example.test`;
  const blocker = await db.transaction();
  let promotion: Promise<Response> | undefined;
  try {
    await db('memberships')
      .where({ workspace_id: fixture.workspaceId, user_id: targetId })
      .update({ role: 'GUEST' });
    await db('board_guest_access').insert({
      id: randomUUID(),
      board_id: fixture.boardId,
      user_id: targetId,
      granted_by: fixture.actorId,
    });

    await lockWorkspaceMembershipMutations(blocker, fixture.workspaceId);
    await blocker('board_guest_access')
      .where({ board_id: fixture.boardId, user_id: targetId })
      .forUpdate()
      .first();

    const token = await createApiToken(fixture.actorId);
    const request = Object.assign(
      new Request(`https://example.test/api/v1/workspaces/${fixture.workspaceId}/members`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: targetEmail, role: 'MEMBER' }),
      }),
      { currentUser: { id: fixture.actorId }, callerRole: 'OWNER' }
    );
    promotion = handleAddMember(request, fixture.workspaceId);

    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await db.raw<{ rows: Array<{ count: string }> }>(`
        SELECT count(*)::text AS count
        FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND wait_event = 'advisory'
          AND query LIKE '%pg_advisory_xact_lock%'
      `);
      if (Number(waiting.rows[0]?.count ?? 0) > 0) break;
      const settled = await Promise.race([
        promotion.then((response) => ({ response })),
        Bun.sleep(25).then(() => null),
      ]);
      if (settled) {
        throw new Error(
          `guest promotion returned ${String(settled.response.status)} before acquiring the workspace lock`
        );
      }
      if (Date.now() >= deadline) {
        throw new Error('guest promotion did not wait on the workspace lock before row mutation');
      }
    }

    await db.transaction(async (probe) => {
      const membership = await probe('memberships')
        .where({ workspace_id: fixture.workspaceId, user_id: targetId })
        .forUpdate()
        .noWait()
        .first<{ role: string }>();
      assert.equal(
        membership.role,
        'GUEST',
        'queued promotion must not lock membership rows first'
      );
    });

    await blocker.commit();
    const response = await promotion;
    assert.equal(
      response.status,
      200,
      'GUEST promotion should complete after workspace lock release'
    );
    console.info('PASS  GUEST promotion acquires workspace lock before membership/guest rows');
  } finally {
    if (!blocker.isCompleted()) await blocker.rollback();
    if (promotion) await Promise.allSettled([promotion]);
    await cleanupFixture(fixture);
  }
}

try {
  await runScenario('demote');
  await runScenario('remove');
  await runScenario('mixed');
  await runStaleAdminScenario();
  await runStaleWorkspaceAuthorityScenario();
  await runConcurrentWorkspaceAuthorityRevocationScenario();
  await runTrelloInvariantScenario('demote');
  await runTrelloInvariantScenario('remove');
  await runTrelloGuestAuthorizationScenario();
  await runTrelloStaleAdminCleanupScenario();
  await runTrelloWorkspaceRemovalScenario();
  await runGuestPromotionLockOrderScenario();
  await runAuthorizationRevocationScenario();
  console.info('\nALL LAST-ADMIN CONCURRENCY CHECKS PASSED');
} finally {
  await db.destroy();
}
