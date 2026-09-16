// tests/integration/historicalImport/historicalImport.test.ts
// Core engine tests — synthetic data only. Covers:
// - manifest contract validation (hash format, provenance, evidence, deps, cycles)
// - historical fidelity (author + timestamps preserved, not attributed to operator/bot)
// - permissions/gates (dry-run default, apply disabled, hash confirmation)
// - dedupe/idempotency (re-run = no-op), duplicates across plans
// - retries/failures (fail-fast, dependency cascade, resumability)
// - no-overwrite of native/drifted content
// - notification/webhook/automation suppression (no domain events dispatched)
// - provenance durability + reset scope
import { describe, expect, it } from 'bun:test';
import {
  applyPlan,
  dryRunPlan,
  resetPlan,
  validatePlan,
  type ImportPlan,
} from '../../../server/extensions/historicalImport/core/plan';
import { hashPlanDocument } from '../../../server/extensions/historicalImport/core/fingerprint';
import { MemoryImporterDeps } from './harness';
import {
  SYNTH_IDENTITY_MAP,
  syntheticPlan,
  SYNTH_EXISTING_CARD,
  existingCardFingerprint,
} from './fixtures';

const OPERATOR = 'usr_operator_0001';

function freshDeps(): MemoryImporterDeps {
  return new MemoryImporterDeps(SYNTH_IDENTITY_MAP);
}

async function validatedPlanHash(plan: ImportPlan, deps: MemoryImporterDeps): Promise<string> {
  const v = await validatePlan(plan, deps, OPERATOR);
  expect(v.ok).toBe(true);
  return v.plan_hash;
}

// ---------------------------------------------------------------------------
// Manifest contract validation
// ---------------------------------------------------------------------------

describe('plan validation — manifest contract', () => {
  it('accepts the synthetic plan and returns a computed plan hash', async () => {
    const deps = freshDeps();
    const v = await validatePlan(syntheticPlan(), deps, OPERATOR);
    expect(v.ok).toBe(true);
    expect(v.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.operations_total).toBe(6);
  });

  it('rejects malformed fingerprints (must be 64-hex sha256)', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    plan.operations[0]!.expected_target_fingerprint = 'deadbeef';
    const v = await validatePlan(plan, deps, OPERATOR);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.code === 'fingerprint-invalid')).toBe(true);
  });

  it('rejects missing evidence_refs', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    plan.operations[0]!.evidence_refs = [];
    const v = await validatePlan(plan, deps, OPERATOR);
    expect(v.errors.some((e) => e.code === 'evidence-refs-required')).toBe(true);
  });

  it('rejects provenance.source_system mismatch with plan.source_system', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    plan.operations[0]!.provenance.source_system = 'asana';
    const v = await validatePlan(plan, deps, OPERATOR);
    expect(v.errors.some((e) => e.code === 'provenance-mismatch')).toBe(true);
  });

  it('rejects duplicate source entities within one plan', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    plan.operations[5]!.source_id = plan.operations[0]!.source_id;
    plan.operations[5]!.entity_type = plan.operations[0]!.entity_type;
    const v = await validatePlan(plan, deps, OPERATOR);
    expect(v.errors.some((e) => e.code === 'duplicate-source')).toBe(true);
  });

  it('rejects unknown and self dependencies', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    plan.operations[1]!.dependencies = ['op-does-not-exist'];
    let v = await validatePlan(plan, deps, OPERATOR);
    expect(v.errors.some((e) => e.code === 'dependency-unknown')).toBe(true);

    const plan2 = syntheticPlan();
    plan2.operations[1]!.dependencies = ['op-comment-1'];
    v = await validatePlan(plan2, deps, OPERATOR);
    expect(v.errors.some((e) => e.code === 'dependency-self')).toBe(true);
  });

  it('rejects dependency cycles', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    plan.operations[0]!.dependencies = ['op-comment-1']; // card depends on comment, comment on card
    const v = await validatePlan(plan, deps, OPERATOR);
    expect(v.errors.some((e) => e.code === 'dependency-cycle')).toBe(true);
  });

  it('rejects two create ops claiming the same target_id', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    plan.operations[2]!.target_id = plan.operations[0]!.target_id; // attachment claims card target
    const v = await validatePlan(plan, deps, OPERATOR);
    expect(v.errors.some((e) => e.code === 'duplicate-target')).toBe(true);
  });

  it('rejects invalid snapshot_hash', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    plan.snapshot_hash = 'zz';
    const v = await validatePlan(plan, deps, OPERATOR);
    expect(v.errors.some((e) => e.code === 'snapshot-hash-invalid')).toBe(true);
  });

  it('writes an audit entry on validation', async () => {
    const deps = freshDeps();
    await validatePlan(syntheticPlan(), deps, OPERATOR);
    expect(deps.audit.length).toBe(1);
    expect(deps.audit[0]!.action).toBe('validate');
    expect(deps.audit[0]!.actor_user_id).toBe(OPERATOR);
  });
});

// ---------------------------------------------------------------------------
// Dry-run: default, no writes
// ---------------------------------------------------------------------------

describe('dry-run — default mode, zero entity writes', () => {
  it('reports planned applications but writes nothing', async () => {
    const deps = freshDeps();
    const result = await dryRunPlan(syntheticPlan(), deps, OPERATOR);
    expect(result.mode).toBe('dry-run');
    expect(result.operations_applied).toBe(6);
    expect(deps.rows.size).toBe(1); // nothing written (1 pre-seeded label remains)
    expect(deps.provenance.length).toBe(0);
  });

  it('writes only a dry_run audit entry', async () => {
    const deps = freshDeps();
    await dryRunPlan(syntheticPlan(), deps, OPERATOR);
    expect(deps.audit.filter((a) => a.action === 'dry_run').length).toBe(1);
  });

  it('fails closed in dry-run when a staged payload is missing, with no writes', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    plan.operations[0]!.payload_ref = 'file:///payloads/plan_synth_0001/missing.json';

    const result = await dryRunPlan(plan, deps, OPERATOR);

    expect(result.operations_applied).toBe(0);
    expect(result.operations_failed).toBe(1);
    expect(result.stopped_early).toBe(true);
    expect(result.outcomes.find((outcome) => outcome.op_id === 'op-card-1')).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('no staged payload'),
    });
    expect(deps.rows.size).toBe(1);
    expect(deps.provenance).toHaveLength(0);
  });

  it('fails closed in dry-run for an author unresolved only in the staged payload', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const payloadRef = plan.operations[0]!.payload_ref!;
    const payload = structuredClone(deps.payloadStore.get(payloadRef)!);
    payload.historical_author = 'm_synth_ghost';
    deps.payloadStore.set(payloadRef, payload);

    const result = await dryRunPlan(plan, deps, OPERATOR);

    expect(result.operations_failed).toBe(1);
    expect(result.outcomes.find((outcome) => outcome.op_id === 'op-card-1')).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('unresolved historical identity'),
    });
    expect(deps.rows.size).toBe(1);
    expect(deps.provenance).toHaveLength(0);
  });

  it('preflights the same injected create failure as apply', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    deps.failCreateFor.add('card:trello_card_synth_0001');

    const result = await dryRunPlan(plan, deps, OPERATOR);

    expect(result.operations_failed).toBe(1);
    expect(result.stopped_early).toBe(true);
    expect(result.operations_blocked).toBe(5); // all unscheduled ops are fail-fast blocked
    expect(deps.rows.size).toBe(1);
    expect(deps.provenance).toHaveLength(0);
  });

  it('returns 422-shaped validation errors for an invalid plan', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    plan.operations[0]!.evidence_refs = [];
    const result = (await dryRunPlan(plan, deps, OPERATOR)) as { validation_errors?: unknown };
    expect(result.validation_errors).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Apply gates
// ---------------------------------------------------------------------------

describe('apply — explicit gates', () => {
  it('refuses when applyEnabled=false', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const hash = await validatedPlanHash(plan, deps);
    const res = await applyPlan(plan, { applyEnabled: false, confirmedPlanHash: hash }, deps, OPERATOR);
    expect('error' in res && res.code === 'apply-disabled').toBe(true);
    expect(deps.rows.size).toBe(1); // only the pre-seeded label
  });

  it('refuses when confirmed hash does not match the plan', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    await validatedPlanHash(plan, deps);
    const res = await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: 'f'.repeat(64) }, deps, OPERATOR);
    expect('error' in res && res.code === 'plan-hash-mismatch').toBe(true);
    expect(deps.rows.size).toBe(1); // only the pre-seeded label
  });

  it('refuses an invalid plan even with correct gates', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    plan.operations[0]!.op_id = ''; // invalid
    const res = await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: 'a'.repeat(64) }, deps, OPERATOR);
    expect('error' in res && res.code === 'plan-invalid').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Historical fidelity
// ---------------------------------------------------------------------------

describe('apply — historical fidelity', () => {
  it('creates the card with historical timestamps and content', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const hash = await validatedPlanHash(plan, deps);
    const res = (await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR)) as {
      operations_applied: number;
    };
    expect(res.operations_applied).toBe(6);
    const card = deps.rows.get('card:crd_synth_0001')!;
    expect(card.title).toBe('Synthetic historical card');
    expect(card.created_at).toBe('2026-01-15T10:00:00.000Z'); // Trello date, not now()
    expect(card.updated_at).toBe('2026-02-20T08:30:00.000Z');
  });

  it('attributes the comment to the historical author — not the operator/bot', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const hash = await validatedPlanHash(plan, deps);
    await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR);
    const comment = deps.rows.get('comment:cmt_synth_0001')!;
    expect(comment.user_id).toBe('usr_synth_alice'); // resolved historical author
    expect(comment.user_id).not.toBe(OPERATOR);
    expect(comment.created_at).toBe('2026-01-16T11:20:00.000Z');
    expect(comment.content).toContain('@bob'); // mention preserved verbatim
  });

  it('records the operator (executor) in audit — separate from historical authors', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const hash = await validatedPlanHash(plan, deps);
    await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR);
    const applyAudit = deps.audit.find((a) => a.action === 'apply')!;
    expect(applyAudit.actor_user_id).toBe(OPERATOR);
    expect(applyAudit.import_plan_hash).toBe(hash);
  });

  it('blocks a comment whose historical author cannot be resolved', async () => {
    const deps = freshDeps();
    // ghost author: identity map deliberately lacks m_synth_ghost
    const plan = syntheticPlan();
    (plan.operations[1] as ImportPlan['operations'][number] & { historical_author?: string }).historical_author =
      'm_synth_ghost';
    const hash = await validatedPlanHash(plan, deps);
    const res = (await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR)) as {
      outcomes: Array<{ status: string; op_id: string; reason?: string }>;
    };
    const outcome = res.outcomes.find((o) => o.op_id === 'op-comment-1')!;
    expect(outcome.status).toBe('blocked');
    expect(outcome.reason).toContain('unresolved historical identity');
  });
});

// ---------------------------------------------------------------------------
// Dedupe / idempotency / no-op
// ---------------------------------------------------------------------------

describe('dedupe and idempotency', () => {
  it('re-running the same plan is a full no-op', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const hash = await validatedPlanHash(plan, deps);
    await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR);

    const second = (await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR)) as {
      operations_applied: number;
      operations_noop: number;
    };
    expect(second.operations_applied).toBe(0);
    expect(second.operations_noop).toBe(6);
    expect(deps.rows.size).toBe(6); // unchanged (pre-seeded label + 5 created)
  });

  it('dry-run after apply reports all no-op', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const hash = await validatedPlanHash(plan, deps);
    await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR);
    const res = await dryRunPlan(plan, deps, OPERATOR);
    expect(res.operations_noop).toBe(6);
    expect(res.operations_applied).toBe(0);
  });

  it('an entity imported by another plan is a no-op, never a duplicate', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const hash = await validatedPlanHash(plan, deps);
    await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR);

    const planB = syntheticPlan();
    planB.plan_id = 'plan_synth_0002';
    planB.operations = planB.operations.slice(0, 1); // same card source id
    const hashB = await validatedPlanHash(planB, deps);
    const res = (await applyPlan(planB, { applyEnabled: true, confirmedPlanHash: hashB }, deps, OPERATOR)) as {
      outcomes: Array<{ status: string; reason?: string }>;
    };
    expect(res.outcomes[0]!.status).toBe('noop');
    expect(res.outcomes[0]!.reason).toContain('already imported');
    expect(deps.rows.get('card:crd_synth_0001')).toBeDefined(); // original intact
  });
});

// ---------------------------------------------------------------------------
// Overwrite prohibition — native rows and drift
// ---------------------------------------------------------------------------

describe('overwrite prohibition', () => {
  it('blocks create with target_id that already exists natively (no provenance)', async () => {
    const deps = freshDeps();
    deps.rows.set(`card:${SYNTH_EXISTING_CARD.id}`, { ...SYNTH_EXISTING_CARD });
    const plan = syntheticPlan();
    plan.operations[0]!.target_id = SYNTH_EXISTING_CARD.id; // aim at the native card
    const hash = await validatedPlanHash(plan, deps);
    const res = (await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR)) as {
      outcomes: Array<{ status: string; op_id: string; reason?: string }>;
    };
    const outcome = res.outcomes.find((o) => o.op_id === 'op-card-1')!;
    expect(outcome.status).toBe('blocked');
    expect(outcome.reason).toContain('overwrite prohibited');
    // native row untouched
    expect(deps.rows.get(`card:${SYNTH_EXISTING_CARD.id}`)).toEqual(SYNTH_EXISTING_CARD);
  });

  it('blocks link onto a drifted target (fingerprint mismatch)', async () => {
    const deps = freshDeps();
    deps.rows.set(`card:${SYNTH_EXISTING_CARD.id}`, { ...SYNTH_EXISTING_CARD });
    const plan = syntheticPlan();
    plan.operations = plan.operations.slice(0, 1);
    plan.operations[0]!.operation = 'link';
    plan.operations[0]!.target_id = SYNTH_EXISTING_CARD.id;
    plan.operations[0]!.expected_target_fingerprint = existingCardFingerprint();
    // drift the row after computing the fingerprint
    deps.rows.get(`card:${SYNTH_EXISTING_CARD.id}`)!.title = 'drifted by a user';
    const hash = await validatedPlanHash(plan, deps);
    const res = (await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR)) as {
      outcomes: Array<{ status: string; reason?: string }>;
    };
    expect(res.outcomes[0]!.status).toBe('blocked');
    expect(res.outcomes[0]!.reason).toContain('fingerprint drift');
  });

  it('allows link when the fingerprint matches exactly', async () => {
    const deps = freshDeps();
    deps.rows.set(`card:${SYNTH_EXISTING_CARD.id}`, { ...SYNTH_EXISTING_CARD });
    const plan = syntheticPlan();
    plan.operations = plan.operations.slice(0, 1);
    plan.operations[0]!.operation = 'link';
    plan.operations[0]!.target_id = SYNTH_EXISTING_CARD.id;
    plan.operations[0]!.expected_target_fingerprint = existingCardFingerprint();
    const hash = await validatedPlanHash(plan, deps);
    const res = (await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR)) as {
      outcomes: Array<{ status: string }>;
    };
    expect(res.outcomes[0]!.status).toBe('applied');
    // link wrote provenance only — no entity mutation
    expect(deps.rows.get(`card:${SYNTH_EXISTING_CARD.id}`)).toEqual(SYNTH_EXISTING_CARD);
    expect(deps.provenance.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Failure handling, retries, dependency cascade
// ---------------------------------------------------------------------------

describe('failures and retries', () => {
  it('fails fast: an injected failure stops the run and cascades to dependents', async () => {
    const deps = freshDeps();
    deps.failCreateFor.add('card:trello_card_synth_0001');
    const plan = syntheticPlan();
    const hash = await validatedPlanHash(plan, deps);
    const res = (await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR)) as {
      operations_failed: number;
      stopped_early: boolean;
      outcomes: Array<{ status: string; op_id: string }>;
    };
    expect(res.operations_failed).toBe(1);
    expect(res.stopped_early).toBe(true);
    // everything depending on the card is blocked, nothing partial-committed
    const cardOutcome = res.outcomes.find((o) => o.op_id === 'op-card-1')!;
    expect(cardOutcome.status).toBe('failed');
    expect(deps.rows.size).toBe(1); // only the pre-seeded label
  });

  it('a retry after fixing the failure completes the remaining operations', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const hash = await validatedPlanHash(plan, deps);
    await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR);

    // Simulate a partial failure: reset provenance for the attachment only.
    deps.provenance = deps.provenance.filter((p) => p.source_id !== 'trello_attach_synth_0001');
    deps.rows.delete('attachment:att_synth_0001');

    const retry = (await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR)) as {
      operations_applied: number;
      operations_noop: number;
    };
    expect(retry.operations_applied).toBe(1); // only the attachment re-created
    expect(retry.operations_noop).toBe(5);
    expect(deps.rows.get('attachment:att_synth_0001')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('concurrency', () => {
  it('two simultaneous applies of the same plan produce one materialisation (dedupe wins, no duplicate rows)', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const hash = await validatedPlanHash(plan, deps);
    const [a, b] = await Promise.all([
      applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR),
      applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR),
    ]);
    const resA = a as { operations_applied: number };
    const resB = b as { operations_applied: number };
    // Both may report applied (read-before-write race) — the invariant that
    // must hold: exactly one row per source entity and one provenance each.
    const cards = [...deps.rows.keys()].filter((k) => k.startsWith('card:'));
    expect(cards.length).toBe(1);
    const cardProv = deps.provenance.filter((p) => p.entity_type === 'card');
    expect(cardProv.length).toBe(1);
    expect(resA.operations_applied + resB.operations_applied).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Suppression of side effects
// ---------------------------------------------------------------------------

describe('side-effect suppression', () => {
  it('dispatches zero domain events (no notifications/webhooks/automation/mentions fan-out)', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const hash = await validatedPlanHash(plan, deps);
    await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR);
    expect(deps.dispatchedDomainEvents.length).toBe(0);
    // and the comment mention text is stored verbatim without notification rows
    expect(deps.rows.get('comment:cmt_synth_0001')!.content).toContain('@bob');
  });
});

// ---------------------------------------------------------------------------
// Reset scope
// ---------------------------------------------------------------------------

describe('reset', () => {
  it('clears provenance for the plan but never deletes entity rows', async () => {
    const deps = freshDeps();
    const plan = syntheticPlan();
    const hash = await validatedPlanHash(plan, deps);
    await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR);
    const res = await resetPlan(hash, deps, OPERATOR);
    expect(res.cleared).toBe(6);
    expect(deps.provenance.length).toBe(0);
    expect(deps.rows.size).toBe(6); // entity rows remain (documented)
    // Re-apply after reset: creates are BLOCKED (rows exist without
    // provenance — overwrite prohibition), only the link re-applies.
    // [why] Reset corrects provenance bookkeeping; it must never lead to
    // duplicate rows or silent overwrites on re-run.
    const again = (await applyPlan(plan, { applyEnabled: true, confirmedPlanHash: hash }, deps, OPERATOR)) as {
      operations_applied: number;
      operations_blocked: number;
      outcomes: Array<{ status: string; op_id: string; reason?: string }>;
    };
    expect(again.operations_applied).toBe(1); // the label link
    expect(again.operations_blocked).toBe(5);
    expect(again.outcomes.find((o) => o.op_id === 'op-card-1')!.reason).toContain('overwrite prohibited');
    expect(deps.rows.size).toBe(6); // still no duplicates
  });
});

// ---------------------------------------------------------------------------
// Plan hash stability
// ---------------------------------------------------------------------------

describe('plan hash', () => {
  it('is stable across validations of the identical document', async () => {
    const deps = freshDeps();
    const p1 = syntheticPlan();
    const p2 = syntheticPlan();
    const h1 = await validatedPlanHash(p1, deps);
    const h2 = await validatedPlanHash(p2, deps);
    expect(h1).toBe(h2);
    expect(hashPlanDocument(p1)).toBe(h1);
  });

  it('changes when any operation changes (tamper detection)', async () => {
    const deps = freshDeps();
    const p1 = syntheticPlan();
    const h1 = await validatedPlanHash(p1, deps);
    const p2 = syntheticPlan();
    p2.operations[0]!.payload_ref = 'file:///payloads/other.json';
    const h2 = await validatedPlanHash(p2, deps);
    expect(h1).not.toBe(h2);
  });
});
