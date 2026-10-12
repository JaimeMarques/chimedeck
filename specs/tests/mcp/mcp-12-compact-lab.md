# MCP 12. Compact results and isolated local acceptance

Use only the explicitly selected checkout/revision and private owned lab state described in the root README. Never reuse production environment files, databases, tokens or dumps.

1. Run `node --test scripts/local-lab/labGuards.test.mjs scripts/local-lab/controller-check.mjs`. Environment loader files, remote Docker endpoints, foreign exact resource names and protected dirty/index/untracked source must refuse before lifecycle mutations. Do not create foreign resources to test refusal.
2. Initialize/start/reset/seed the owned lab using its explicit local Unix Docker endpoint. Validate effective localhost publications and read-only DB ownership marker. Stopped `status` must remain observational. Reset must touch only known owned resources; seed must refuse nonempty or wrong-marker databases.
   Loaded app provenance must match actual container ID and selected revision. Pin alone does not certify cached code; clean proofs reject development-started/stale/missing metadata until fresh restart. Explicit development proof refreshes hosted app before fresh stdio. Interrupted exact owned migrations use snapshot IDs; auto-removal is harmless, similar foreign/legacy oneoffs refuse before mutation.
3. Run the lab `test`, `guards` and `browser` commands. Real stdio and HTTP sessions must discover the same 61 tools, enforce restricted-user access and parent scope, and exercise synthetic board/list/card/checklist/comment/reply/attachment CRUD. The browser must log in through the real form and show the full UTF-8 description and `/developer/mcp` batch/compact documentation.
4. Read a card with default compact and explicit full views. Require complete descriptions and checklist text once; list/search summaries omit descriptions unless requested. Both views scrub private IP/user-agent fields and tokens. No silent truncation or duplicated full-card write bodies are allowed.
5. On a card with 25 parent threads, default discussion selects the latest 20 with all direct replies: `page_complete` can be true while `complete` is false. `all: true` reads all 25; explicit limit/offset plus all must fail before HTTP. Inspect scope, pagination and per-parent issues; reply failures retain successful threads.
6. Verify acknowledged creation IDs survive failed secondary reads. Do not retry an acknowledged or unknown creation. Verify native sanitized/trimmed expectations and actual observed fields, strict timestamp microseconds and decimal comparisons. Wrong item/checklist acknowledgement IDs must never verify success.
7. Batch two unique items: expect two PATCH plus preflight/final GET. Separately inspect request outcome and observation. Unknown request plus observed match retains its error and per-item verified true while top complete stays false and partial true. Final read failures use readback_error; no retry/rollback is implied.
8. Local stdio requires absolute destPath before any request, streams a file over 10 MB without binary context, and preserves the prior destination on failure. Progressing transfers may exceed the bounded header/setup budget; an idle stall or abort observed at buffered EOF must never publish. Reader/setup failures and stalled cancellation must not strand temporary files. Hosted HTTP exposes no writable path and retains the capped in-band contract and total deadline. Scope, redirects, readiness, size and cleanup failures must fail safely.

Automated protocol proof:

```bash
bun test server/extensions/mcp
node --test scripts/local-lab/labGuards.test.mjs scripts/local-lab/controller-check.mjs
```

Repository-wide type/full-suite failures must be compared with the same canonical base and reported as known baseline issues. Focused success does not certify a green full suite. No acceptance step authorizes production writes, connection switches or deployment.
