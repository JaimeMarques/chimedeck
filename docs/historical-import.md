# ChimeDeck — Via de Importação Histórica (Trello → ChimeDeck)

Branch: `feat/historical-import-admin` (a partir de `20ee518` — HEAD verificado, igual ao observado anteriormente)
Upstream: github.com/Chimedeck/chimedeck · Fork: MrTheSoulz/chimedeck

## O que foi implementado (extensão administrativa REST, via única)

Código novo — nada do upstream foi alterado exceto 2 linhas de montagem:

| Ficheiro | Papel |
|---|---|
| `db/migrations/0119_historical_import.ts` | Tabelas `import_provenance` (origem durável por tipo/ID, única por `(source_system, entity_type, source_id)` e por `target_ref`) e `import_audit_log` (append-only, executor ≠ autor histórico). Rollback limpo (down apaga só estas duas). |
| `server/extensions/historicalImport/core/fingerprint.ts` | Canonização JSON + SHA-256 (`sha256-fingerprint-v1`, `sha256-plan-v1`). Puro, sem DB. |
| `server/extensions/historicalImport/core/plan.ts` | Motor: `validatePlan` / `dryRunPlan` (default) / `applyPlan` (com gates) / `resetPlan`. Contrato de manifest completo. |
| `server/extensions/historicalImport/core/adapters.ts` | `ImporterDeps` knex: transação por operação (linha + provenance, ou nada), `payload_ref` resolvido **só no servidor** a partir de `HISTORICAL_IMPORT_PAYLOAD_ROOT` (nada de payloads no transporte/API), identity map de `HISTORICAL_IMPORT_IDENTITY_MAP`. |
| `server/extensions/historicalImport/api/authorize.ts` | OWNER do workspace é obrigatório; plano multi-workspace rejeitado; gates por env avaliados por request. |
| `server/extensions/historicalImport/api/router.ts` | `/api/v1/admin/historical-import/{validate,dry-run,apply,reset,provenance,audit}` montado em `server/index.ts` (antes do MCP handler). |
| `server/extensions/mcp/tools/importValidate.ts`, `importRun.ts` | Ferramentas MCP `historical_import_validate`, `historical_import_dry_run`, `historical_import_reset`. **Apply não tem ferramenta MCP** — permanece REST auditado. |
| `tests/integration/historicalImport/` + `tests/unit/.../historicalImport/` | 49 testes (fixtures 100% sintéticas, sem PII). |

## Contrato do manifest (mínimo partilhado, mantido)

```jsonc
{
  "plan_id": "plan_...",                       // obrigatório
  "source_system": "trello",
  "snapshot_hash": "<sha256 hex 64>",          // opcional mas validado se presente
  "created_at": "ISO-8601",
  "operations": [{
    "op_id": "op-001",                          // único no plano
    "entity_type": "card|comment|comment_reaction|attachment|checklist|checklist_item|label|card_label|card_member|custom_field|custom_field_value|activity|mention|list|board",
    "source_id": "<id Trello>",                 // obrigatório
    "target_id": "<id destino opcional>",
    "operation": "create|link",
    "provenance": { "source_system": "trello", "source_id": "<= source_id", "evidence_refs": ["trello-export:..."], "board_id": "<para autorização>" },
    "evidence_refs": ["trello-export:actions/..."],   // ≥ 1 obrigatória
    "expected_target_fingerprint": "<sha256 64>|null",
    "payload_ref": "file://<caminho privado no servidor>|null",
    "dependencies": ["op-..."],                 // acíclico, tem de existir
    "historical_author": "<id Trello do autor>" // opcional (extensão nossa); não resolvido => op BLOQUEADA
  }]
}
```

## Gates e garantias

1. **Dry-run por defeito** — `dry-run` não escreve nada em tabelas de entidades; só audit log.
2. **Apply duplamente fechado** — (a) `HISTORICAL_IMPORT_APPLY_ENABLED=true` no servidor; (b) `confirmed_plan_hash` = hash calculado do plano (o hash vem do validate/dry-run). Hash alterado => 403 `plan-hash-mismatch`.
3. **Extensão desligada por defeito** — `HISTORICAL_IMPORT_ENABLED=true` necessário; sem ele todas as rotas devolvem 503.
4. **Autorização** — owner do workspace (via `provenance.board_id` de cada operação); plano que atravesse workspaces é rejeitado; RBAC normal do ChimeDeck reutilizado.
5. **Identidades** — `historical_author` resolvido via identity map; **não resolvido bloqueia a operação** (nunca salta, nunca atribui ao bot/executante).
6. **Dedupe/idempotência** — provenance existente para a fonte => no-op (mesmo plano: "idempotent re-run"; outro plano: indica o plano anterior). Re-run do plano aplicado = 0 applied, N noop.
7. **Sem overwrites** — create sobre target existente sem provenance => `blocked` ("overwrite prohibited", cobre nativo e drift); link com `expected_target_fingerprint` divergente => `blocked` ("fingerprint drift").
8. **Sem destruição** — nenhum endpoint faz DELETE/UPDATE de conteúdo nativo; `reset` limpa só provenance do plano (linhas de entidades ficam; re-apply depois de reset bloqueia as creates — sem duplicações).
9. **Falhas** — por operação: transação knex (linha+provenance ou nada); falha injectada => fail-fast, resto bloqueado por dependência, retry após correcção aplica só o que falta.
10. **Supressão de efeitos** — escritas directa knex, sem `dispatchEvent`/`writeActivity`/pubsub/mentions-sync dos caminhos normais: zero notificações, webhooks, automatismos ou DMs; audit trail do executante separado (`import_audit_log.actor_user_id`) dos autores históricos (`comments.user_id` = autor resolvido; `import_provenance` mantém a fonte).
11. **Concorrência** — duas applies simultâneas do mesmo plano => uma materialização (invariante testado: 1 linha por fonte, 1 provenance por entidade).

## Matriz de capacidades vs. lacunas (representabilidade histórica)

| Requisito (Trello) | Estado | Notas |
|---|---|---|
| Criadores/autores de comments | ✅ preservado | `historical_author` → user resolvido; timestamp histórico em `created_at`/`updated_at` |
| Members (responsáveis de cartão) | ✅ suportado | `card_member` (create/link) com identity map |
| Timestamps de acções | ✅ preservado | payload staged: `created_at`/`updated_at`; **não** `new Date()` |
| Comentários/replies | ⚠️ parcial | comentário ✅; reply de 1 nível possível via `parent_id` no payload; a profundidade é 1 no ChimeDeck (limitação nativa) |
| Mentions | ⚠️ parcial | texto `@nick` preservado verbatim; tabela `mentions` pode ser criada via operação `mention`; **notificações de menção não são geradas** (supressão é intencional) |
| Reactions de comentários | ✅ suportado | `comment_reaction` (create) |
| Attachments (bytes) | ⚠️ parcial | linha `attachments` ✅; **bytes têm de ser carregados para S3 à parte** (payload indica `s3_key`); o import não transfere bytes do Trello |
| Labels | ✅ suportado | `label` (create/link; link exige fingerprint) |
| Checklists + items | ✅ suportado | `checklist`, `checklist_item` (assignment/due nativos no payload) |
| Custom fields + valores | ✅ suportado | `custom_field`, `custom_field_value` (tipos TEXT/NUMBER/DATE/CHECKBOX/DROPDOWN) |
| Datas (due/start) | ✅ suportado | colunas `due_date`, `due_complete`, `start_date` no payload |
| Ordem (pos) | ✅ suportado | posições fracionárias string; conversão numérica Trello é responsabilidade do gerador do plano |
| Covers | ⚠️ parcial | colunas existem (`cover_attachment_id`/`cover_color`/`cover_size`) — definíveis no payload; sem validação específica |
| Estados arquivados | ✅ suportado | `archived` no payload (card/list); boards via `state` |
| Actions históricas (audit) | ⚠️ parcial | `activity` pode ser criado como linha; **o feed nativo de activity não é reconstruído** — provenance+evidence_refs são o registo histórico canónico |
| Avatares | ❌ lacuna | download/upload de avatares Trello não implementado (o seed upstream fazia; aqui fica fora do âmbito — operador pode pré-criar users com avatar) |
| Criação de users | ❌ lacuna explícita | o import **não cria users**; todos os `historical_author` têm de resolver no identity map para users existentes (bloqueia caso contrário) |
| Notificações/webhooks/automation dos eventos importados | ✅ suprimidos (requisito) | zero eventos de domínio; audit separado |

Bloqueios explícitos por não-preservável: avatares e criação de users (ver lacunas); bytes de anexos exigem etapa S3 externa ao plano.

## Como operar (QA + integrator — ensaio em staging)

Pré-requisitos no servidor de staging:
```bash
export HISTORICAL_IMPORT_ENABLED=true          # liga a extensão (sem apply)
export HISTORICAL_IMPORT_APPLY_ENABLED=true    # só na janela de apply, depois desligar
export HISTORICAL_IMPORT_PAYLOAD_ROOT=/var/lib/chimedeck/import-payloads   # root privada
export HISTORICAL_IMPORT_IDENTITY_MAP=/var/lib/chimedeck/identity-map.json # {"<trello_id>": "<user_id>"}
```

1. `bun run db:migrate` (aplica 0119 — aditiva, reversível com `db:rollback`).
2. Gerar plano + payloads staged (fora do âmbito deste PR; o gerador consome o export Trello e escreve `payload_ref` sob o root).
3. Token de API (`hf_...`) de um user OWNER do workspace alvo.
4. Validar e obter o hash:
```bash
curl -s -X POST "$APP_URL/api/v1/admin/historical-import/validate" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"plan\": $(cat plan.json)}" | jq '.data.validation.plan_hash, .data.validation.ok'
```
5. Ensaio (não escreve nada):
```bash
curl -s -X POST "$APP_URL/api/v1/admin/historical-import/dry-run" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"plan\": $(cat plan.json)}" | jq '.data.result'
```
6. Apply (exige `HISTORICAL_IMPORT_APPLY_ENABLED=true` e o hash confirmado):
```bash
HASH=<plan_hash do passo 4>
curl -s -X POST "$APP_URL/api/v1/admin/historical-import/apply" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"plan\": $(cat plan.json), \"confirmed_plan_hash\": \"$HASH\"}" | jq '.data.result'
```
7. Auditoria/verificação:
```bash
curl -s "$APP_URL/api/v1/admin/historical-import/audit?plan_hash=$HASH" -H "Authorization: Bearer $TOKEN" | jq
curl -s "$APP_URL/api/v1/admin/historical-import/provenance?entity_type=card&source_id=<trello_id>" -H "Authorization: Bearer $TOKEN" | jq
```
8. Recuperação: re-executar apply (idempotente); falha parcial => corrigir e re-aplicar; correcção de provenance => `POST /reset {"plan_hash": "$HASH"}` (nunca apaga entidades).

Via MCP (staging): `historical_import_validate`, `historical_import_dry_run`, `historical_import_reset` — **apply é apenas REST**.

## Verificação executada nesta tarefa

- `bun test tests/integration/historicalImport/ tests/unit/server/extensions/historicalImport/` → **49 pass / 0 fail**.
- Suite completa: 1221 testes no branch vs 1172 no baseline `20ee518` (os +49 são nossos); conjunto de falhas **idêntico** ao baseline (167 falhas pré-existentes no upstream: JWT keys ausentes, Playwright specs apanhados pelo bun test, exports stateTransitions desactualizados nos testes do próprio upstream — nenhuma nossa).
- `tsc --noEmit`: 175 erros no branch = 175 erros no baseline (0 novos). O upstream em `20ee518` não passa typecheck nem lint limpos.
- ESLint: o upstream já falha `strictTypeChecked` nos próprios ficheiros (198 erros só em `board/`+`label/`); os nossos erros residuais são das mesmas categorias knex/`no-unnecessary-condition`; corrigidos os reais (unused vars, non-null assertion, require-await, unions redundantes).

## Riscos / notas para revisão

- `payload_ref` depende de ficheiro staged no host — o gerador de planos (etapa de planeamento/ensaio) tem de garantir que o root existe e os ficheiros correspondem ao plano (o hash do plano cobre as refs, não o conteúdo dos payloads; integridade do conteúdo é do snapshot `snapshot_hash`).
- Concorrência real em Postgres: `createWithProvenance` usa transação + verificação de provenance dentro da transação (o unique em `(source_system, entity_type, source_id)` é a última defesa; segunda writer recebe erro => registo failed + retry idempotente).
- `reset` não apaga linhas de entidades (documentado); se o operador quiser remover linhas importadas, é operação manual fora desta via (decisão consciente: zero deleções no âmbito).
