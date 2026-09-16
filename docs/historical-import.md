# ChimeDeck — Via de Importação Histórica (Trello → ChimeDeck)

Branch: `feat/historical-import-admin` (a partir de `20ee518` — HEAD verificado, igual ao observado anteriormente)
Upstream: github.com/Chimedeck/chimedeck · Fork: MrTheSoulz/chimedeck

## O que foi implementado (extensão administrativa REST, via única)

Código novo — nada do upstream foi alterado exceto 2 linhas de montagem:

| Ficheiro                                                                   | Papel                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/migrations/0119_historical_import.ts`                                  | Tabelas `import_provenance` (origem durável por tipo/ID, única por `(source_system, entity_type, source_id)` e por `target_ref`) e `import_audit_log` (append-only, executor ≠ autor histórico). Rollback limpo (down apaga só estas duas).                |
| `server/extensions/historicalImport/core/fingerprint.ts`                   | Canonização JSON + SHA-256 (`sha256-fingerprint-v1`, `sha256-plan-v1`). Puro, sem DB.                                                                                                                                                                      |
| `server/extensions/historicalImport/core/composite.ts`                     | Chaves compostas (join tables `card_labels`/`card_members`, sem coluna `id`): codificação canónica de `target_id`, descodificação fail-closed e `target_ref` de proveniência. Puro, sem DB.                                                                |
| `server/extensions/historicalImport/core/columns.ts`                       | Projeção de timestamps históricos: colunas reais do destino lidas do schema **live** (`information_schema.columns`), cache por tabela por plan run, fail-closed se a metadata não resolver; decidem se um `created_at`/`updated_at` declarado entra na linha. Puro + injectável (`ColumnProbe`), testável sem DB.               |
| `server/extensions/historicalImport/core/plan.ts`                          | Motor: `validatePlan` / `dryRunPlan` (default) / `applyPlan` (com gates) / `resetPlan`. Contrato de manifest completo.                                                                                                                                     |
| `server/extensions/historicalImport/core/adapters.ts`                      | `ImporterDeps` knex: transação por operação (linha + provenance, ou nada), `payload_ref` resolvido **só no servidor** a partir de `HISTORICAL_IMPORT_PAYLOAD_ROOT` (nada de payloads no transporte/API), identity map de `HISTORICAL_IMPORT_IDENTITY_MAP`. |
| `server/extensions/historicalImport/api/authorize.ts`                      | OWNER do workspace é obrigatório; plano multi-workspace rejeitado; gates por env avaliados por request.                                                                                                                                                    |
| `server/extensions/historicalImport/api/router.ts`                         | `/api/v1/admin/historical-import/{validate,dry-run,apply,reset,provenance,audit}` montado em `server/index.ts` (antes do MCP handler).                                                                                                                     |
| `server/extensions/mcp/tools/importValidate.ts`, `importRun.ts`            | Ferramentas MCP `historical_import_validate`, `historical_import_dry_run`, `historical_import_reset`. **Apply não tem ferramenta MCP** — permanece REST auditado.                                                                                          |
| `tests/integration/historicalImport/` + `tests/unit/.../historicalImport/` | 132 testes (fixtures 100% sintéticas, sem PII).                                                                                                                                                                                                             |

## Contrato do manifest (mínimo partilhado, mantido)

```jsonc
{
  "plan_id": "plan_...", // obrigatório
  "source_system": "trello",
  "snapshot_hash": "<sha256 hex 64>", // opcional mas validado se presente
  "created_at": "ISO-8601",
  "operations": [
    {
      "op_id": "op-001", // único no plano
      "entity_type": "card|comment|comment_reaction|attachment|checklist|checklist_item|label|card_label|card_member|custom_field|custom_field_value|activity|mention|list|board",
      "source_id": "<id Trello>", // obrigatório
      "target_id": "<id destino opcional>", // OBRIGATÓRIO e composto para card_label/card_member (ver abaixo)
      "operation": "create|link|correct|enrich",
      "provenance": {
        "source_system": "trello",
        "source_id": "<= source_id",
        "evidence_refs": ["trello-export:..."],
        "board_id": "<para autorização>",
        "workspace_id": "<testemunho de autorização, só em creates de board>",
      },
      "evidence_refs": ["trello-export:actions/..."], // ≥ 1 obrigatória
      "expected_target_fingerprint": "<sha256 64>|null",
      "expected_target_fields": {
        /* obrigatório e exacto para correct/enrich */
      },
      "payload_ref": "file://<caminho privado no servidor>|null",
      "dependencies": ["op-..."], // acíclico, tem de existir
      "historical_author": "<id Trello do autor>", // opcional (extensão nossa); não resolvido => op BLOQUEADA
    },
  ],
}
```

### Operações mutáveis e objectos staged

- `correct` só aceita `entity_type=comment`, `target_id`, `payload_ref`, `historical_author` resolvido e a pré-imagem exacta `expected_target_fields={user_id,content,created_at,updated_at,parent_id}`. O adapter bloqueia drift, comentários apagados e claims incompatíveis; actualiza apenas esses campos e grava/verifica provenance na mesma transação. Re-run com a pós-imagem exacta é `noop`.
- `enrich` só aceita `entity_type=card` e uma pré-imagem de cover vazia `{cover_attachment_id:null,cover_color:null,cover_size:"SMALL"}`. O payload define exactamente uma cover (cor hex ou attachment `READY`, imagem, no mesmo cartão e import-owned) e `cover_size=SMALL|FULL`; nunca limpa nem substitui uma cover nativa.
- Um payload `attachment` com `type=FILE` exige `object_precondition={bucket,key,byte_count,sha256}`. Bucket/key/size têm de coincidir com os campos da linha e o objecto é lido e SHA-256 verificado tanto no dry-run como no apply antes de qualquer linha/provenance.
- Creates de `board` exigem `historical_author` igual ao `workspaces.owner_id`, membership `OWNER`, e criam `board_members(role=ADMIN)` atomicamente. Board/card/list/comment/attachment recebem `short_id` nativo único de 8 caracteres quando não fornecido.
- **Create de `board` exige `provenance.workspace_id`** (testemunho de autorização do workspace). O board ainda não existe, por isso não pode ser lido da tabela `boards`: a API resolve o workspace a partir do **payload staged** (`fields.workspace_id` + `historical_author` → `workspaces.owner_id` + membership `OWNER` — a mesma porta que o create aplica) e exige que o valor declarado coincida com o provado. As operações que autorizam através desse board novo (list/card/comment com `provenance.board_id` = board criado) usam o mesmo testemunho, em vez de falharem com `board-not-found`. Todos os testemunhos (boards existentes + boards criados) têm de resolver para **um** workspace, e o operador tem de ser OWNER desse workspace. Erros: `board-create-witness-required` (400), `board-create-witness-invalid` (400, não provável), `board-create-witness-mismatch` (400, declarado ≠ provado ou target já existente noutro workspace), `board-not-found` (404, board referenciado que o plano não cria). Se o target declarado já existir, tem de estar no workspace testemunhado.
- **Cadeia de cover com anexo** (`card create|link` → `attachment create` → `card enrich`): a mesma `source_id`/`target_id` de cartão pode aparecer **duas vezes** no plano, e só nesta forma — `enrich` diretamente dependente (i) da materialização do cartão (`create` ou `link`) e (ii) do anexo de cover import-owned (uma op `attachment create|link` que dependa da mesma materialização), `op_id`s distintos, uma só claim de proveniência (o `enrich` reutiliza a claim existente e apenas actualiza `last_verified_at`), pré-imagem **exactamente vazia** `{cover_attachment_id:null,cover_color:null,cover_size:"SMALL"}` e re-run idempotente. Qualquer outro caso duplicado continua recusado (`duplicate-source`); violações da forma são reportadas como `enrich-chain-dependency-missing`, `enrich-chain-attachment-missing` ou `enrich-preimage-not-empty`.
- **Timestamps históricos** (`created_at`/`updated_at` no topo do payload staged) são projetados a partir do schema **real** do destino (`information_schema.columns`, uma leitura por tabela por plan run, com cache): entram na linha apenas quando a tabela destino tem a coluna. `cards`, `comments`, `attachments` e `checklists` têm ambas; `boards`, `activities`, `comment_reactions`, `custom_fields` e `mentions` têm só `created_at` (um `updated_at` declarado é omitido); `lists`, `checklist_items`, `labels` e `card_custom_field_values` não têm nenhuma (ambos omitidos). Uma omissão **nunca é silenciosa**: fica um aviso no log do servidor (`[historicalImport] staged <campo> cannot be preserved for <entity_type>: table <tabela> has no <campo> column — omitted`), uma vez por entidade/campo por plan run. Nenhuma coluna é criada, renomeada ou reaproveitada, e a resolução da metadata corre **dentro** do corpo partilhado por dry-run e apply: se a metadata não resolver (tabela/schema desconhecidos), a operação **falha** em vez de descartar história. Chaves dentro de `fields` continuam a ser passadas verbatim (contrato `fields` = coluna do destino ⇒ valor): uma coluna inexistente aí continua a falhar o INSERT, por desenho.
- **Ensaio (dry-run) partilhado** — todas as operações de um `dry-run` correm numa única transação de ensaio (savepoint por operação, `ROLLBACK` no fim): as escritas ficam visíveis às operações que delas dependem (um cartão criado pode receber o seu anexo e o seu cover no mesmo ensaio), o schema real valida tudo (NOT NULL/CHECK/FK/unique) e nada fica durável. Sem esta partilha, uma cadeia `create → filho` não podia ser ensaiada. O audit (`validate`/`dry_run`) é escrito fora da transação.

### Join tables — chave composta (card_labels / card_members)

`card_labels(card_id, label_id)` e `card_members(card_id, user_id)` são **chaves primárias compostas em varchar e não têm coluna `id`**. Como o contrato endereça cada destino por uma única string (`target_ref = "<entity_type>:<target_id>"`, único), a chave composta é codificada canonicamente:

| entity_type   | `target_id`            | exemplo             |
| ------------- | ---------------------- | ------------------- |
| `card_label`  | `<card_id>:<label_id>` | `3f2c…-a1:9b7d…-c2` |
| `card_member` | `<card_id>:<user_id>`  | `3f2c…-a1:us_1234`  |

Regras (implementadas em `core/composite.ts`, aplicadas pelo motor e pelo adapter):

1. **Obrigatório** — o motor nunca sintetiza um `id` para estas tabelas; `target_id` tem de vir do plano (`composite-target-required`).
2. **Formato** — partes separadas por `:` na ordem das colunas acima; cada parte é um id válido (`[A-Za-z0-9._~-]+`). Um `target_id` malformado é rejeitado na validação (`composite-target-invalid`), nunca interpretado.
3. **Proveniência** — `target_id` é a string composta; `target_ref` fica `card_label:<card_id>:<label_id>` (único, dedupe por constraint). Não é precisa migração.
4. **Escrita** — o insert usa apenas as colunas da chave (+ campos do payload, nunca `id`); se o payload declarar uma coluna da chave com valor diferente do `target_id`, a operação **falha** (fail-closed, nada escrito).
5. **Oraclos** — `card_id`, `label_id` e `user_id` têm de existir (o import nunca cria users nem labels em falta); a ausência é reportada como erro explícito em vez de violação FK `23503`.
6. **Sem overwrites** — se a atribuição já existir sem proveniência (nativa ou drift), a `create` é `blocked` ("overwrite prohibited"); a `link` de uma linha existente é o caminho suportado e escreve apenas proveniência.
7. **`payload_ref`** — opcional para estes tipos (a linha só tem colunas de chave).
8. O planner tem de resolver `user_id`/`label_id` para ids ChimeDeck **antes** de emitir o plano (o identity map é do lado do operador).

## Gates e garantias

1. **Dry-run por defeito** — `dry-run` não escreve nada em tabelas de entidades; só audit log. Devolve `destination_fingerprint` (testemunho do estado) sem escrever linhas (verificado em Postgres real: delta de linhas = 0).
2. **Apply triplamente fechado** — (a) `HISTORICAL_IMPORT_APPLY_ENABLED=true` no servidor; (b) `confirmed_plan_hash` = hash calculado do plano (o hash vem do validate/dry-run); hash alterado => 403 `plan-hash-mismatch`; (c) `confirmed_destination_fingerprint` = testemunho de estado devolvido pelo validate/dry-run — **obrigatório**; ausente/malformado => 400; divergente => 409 `destination-state-divergence` (ver §4).
3. **Extensão desligada por defeito** — `HISTORICAL_IMPORT_ENABLED=true` necessário; sem ele todas as rotas devolvem 503.
4. **Paragem por divergência do estado de destino** — `validate`/`dry-run`/`apply` observam, por operação, a linha alvo e o seu _claim_ de proveniência e resumem tudo em `destination_fingerprint` (sha256 sobre `{op_id, entity_type, target_id, row_present, row_fingerprint, provenance_ref}` na ordem do manifest), calculado **antes** de qualquer escrita. O operador confirma esse valor no apply; se qualquer linha tocada mudar (rename, edição nativa, linha removida, claim nova), o apply é recusado e não escreve nada. Cobre também `link`, que uma precondition por fingerprint não apanha.
5. **Paragem por divergência do snapshot de origem** — `HISTORICAL_IMPORT_EXPECTED_SNAPSHOT_HASH` (valor congelado, fora de banda) é comparado com `plan.snapshot_hash`: divergência => `snapshot-divergence` no validate (ok=false) e recusa no apply. Sem essa env, o `snapshot_hash` é apenas validado por forma e o validate emite o aviso `snapshot-hash-unpinned` (o plano nunca autoriza o seu próprio snapshot).
6. **Autorização** — owner do workspace (via `provenance.board_id` de cada operação), mais o testemunho `provenance.workspace_id` para boards que o plano cria (ver §Operações mutáveis); plano que atravesse workspaces é rejeitado; RBAC normal do ChimeDeck reutilizado. O `reset`/recuperação autoriza pelo workspace da primeira linha de proveniência do plano (para join tables a chave composta é descodificada para chegar ao cartão).
7. **Identidades** — `historical_author` resolvido via identity map; **não resolvido bloqueia a operação** (nunca salta, nunca atribui ao bot/executante).
8. **Dedupe/idempotência** — provenance existente para a fonte => no-op (mesmo plano: "idempotent re-run"; outro plano: indica o plano anterior). Re-run do plano aplicado = 0 applied, N noop. Colisão de unicidade em corrida (`23505`) é relida e resolvida como materialização existente, em vez de falhar a operação.
9. **Sem overwrites** — create sobre target existente sem provenance => `blocked` ("overwrite prohibited", cobre nativo e drift); link com `expected_target_fingerprint` divergente => `blocked` ("fingerprint drift").
10. **Sem destruição não autorizada** — nenhuma operação faz UPDATE de conteúdo nativo; `reset` sem `recovery=true` limpa só provenance do plano e **reporta** as linhas criadas que ficam (`created_targets_remaining`), com a nota de que a re-execução fica bloqueada. A variante `recovery=true` é destrutiva, explícita e restrita (ver §Recuperação).
11. **Falhas** — por operação: transação knex (linha+provenance ou nada); falha injectada => fail-fast, resto bloqueado por dependência, retry após correcção aplica só o que falta.
12. **Supressão de efeitos** — escritas directa knex, sem `dispatchEvent`/`writeActivity`/pubsub/mentions-sync dos caminhos normais: zero notificações, webhooks, automatismos ou DMs; audit trail do executante separado (`import_audit_log.actor_user_id`) dos autores históricos (`comments.user_id` = autor resolvido; `import_provenance` mantém a fonte).
13. **Concorrência** — duas applies simultâneas do mesmo plano => uma materialização (invariante testado: 1 linha por fonte, 1 provenance por entidade). Com o gate de estado, uma delas pode ser recusada por `destination-state-divergence` (comportamento desejado: só a corrida que confirmou o estado observado avança).

## Matriz de capacidades vs. lacunas (representabilidade histórica)

| Requisito (Trello)                                      | Estado                    | Notas                                                                                                                                                             |
| ------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Criadores/autores de comments                           | ✅ preservado             | `historical_author` → user resolvido; timestamp histórico em `created_at`/`updated_at`                                                                            |
| Members (responsáveis de cartão)                        | ✅ suportado              | `card_member` (create/link) com identity map; chave composta `<card_id>:<user_id>` (a tabela não tem `id`)                                                        |
| Timestamps de acções                                    | ✅ preservado (onde existe coluna) | payload staged: `created_at`/`updated_at`; **não** `new Date()`. Só entram nas tabelas que têm a coluna (ver "Timestamps históricos" acima): `lists`/`checklist_items`/`labels`/`card_custom_field_values` não guardam timestamp nenhum e um `updated_at` declarado é omitido em `boards`/`activities`/etc. — sempre com aviso no log |
| Comentários/replies                                     | ⚠️ parcial                | comentário ✅; reply de 1 nível possível via `parent_id` no payload; a profundidade é 1 no ChimeDeck (limitação nativa)                                           |
| Mentions                                                | ⚠️ parcial                | texto `@nick` preservado verbatim; tabela `mentions` pode ser criada via operação `mention`; **notificações de menção não são geradas** (supressão é intencional) |
| Reactions de comentários                                | ✅ suportado              | `comment_reaction` (create)                                                                                                                                       |
| Attachments (bytes)                                     | ⚠️ parcial                | linha `attachments` ✅; **bytes têm de ser carregados para S3 à parte** (payload indica `s3_key`); o import não transfere bytes do Trello                         |
| Labels                                                  | ✅ suportado              | `label` (create/link; link exige fingerprint). A atribuição `card_label` (create/link) usa chave composta `<card_id>:<label_id>`                                  |
| Checklists + items                                      | ✅ suportado              | `checklist`, `checklist_item` (assignment/due nativos no payload)                                                                                                 |
| Custom fields + valores                                 | ✅ suportado              | `custom_field`, `custom_field_value` (tipos TEXT/NUMBER/DATE/CHECKBOX/DROPDOWN)                                                                                   |
| Datas (due/start)                                       | ✅ suportado              | colunas `due_date`, `due_complete`, `start_date` no payload                                                                                                       |
| Ordem (pos)                                             | ✅ suportado              | posições fracionárias string; conversão numérica Trello é responsabilidade do gerador do plano                                                                    |
| Covers                                                  | ⚠️ parcial                | colunas existem (`cover_attachment_id`/`cover_color`/`cover_size`) — definíveis no payload; sem validação específica                                              |
| Estados arquivados                                      | ✅ suportado              | `archived` no payload (card/list); boards via `state`                                                                                                             |
| Actions históricas (audit)                              | ⚠️ parcial                | `activity` pode ser criado como linha; **o feed nativo de activity não é reconstruído** — provenance+evidence_refs são o registo histórico canónico               |
| Avatares                                                | ❌ lacuna                 | download/upload de avatares Trello não implementado (o seed upstream fazia; aqui fica fora do âmbito — operador pode pré-criar users com avatar)                  |
| Criação de users                                        | ❌ lacuna explícita       | o import **não cria users**; todos os `historical_author` têm de resolver no identity map para users existentes (bloqueia caso contrário)                         |
| Notificações/webhooks/automation dos eventos importados | ✅ suprimidos (requisito) | zero eventos de domínio; audit separado                                                                                                                           |

Bloqueios explícitos por não-preservável: avatares e criação de users (ver lacunas); bytes de anexos exigem etapa S3 externa ao plano.

## Como operar (QA + integrator — ensaio em staging)

Pré-requisitos no servidor de staging:

```bash
export HISTORICAL_IMPORT_ENABLED=true          # liga a extensão (sem apply)
export HISTORICAL_IMPORT_APPLY_ENABLED=true    # só na janela de apply, depois desligar
export HISTORICAL_IMPORT_PAYLOAD_ROOT=/var/lib/chimedeck/import-payloads   # root privada
export HISTORICAL_IMPORT_IDENTITY_MAP=/var/lib/chimedeck/identity-map.json # {"<trello_id>": "<user_id>"}
export HISTORICAL_IMPORT_EXPECTED_SNAPSHOT_HASH=<sha256 do snapshot de origem congelado>  # paragem por divergência do snapshot (recomendado)
export HISTORICAL_IMPORT_RESET_RECOVERY_ENABLED=true   # SÓ se precisar de recuperação destrutiva (ver passo 8)
```

1. `bun run db:migrate` (aplica 0119 — aditiva, reversível com `db:rollback`).
2. Gerar plano + payloads staged (fora do âmbito deste PR; o gerador consome o export Trello e escreve `payload_ref` sob o root). Para `card_label`/`card_member`, o gerador emite `target_id` composto (`<card_id>:<label_id>` / `<card_id>:<user_id>`).
3. Token de API (`hf_...`) de um user OWNER do workspace alvo.
4. Validar e obter o hash **e o testemunho de estado**:

```bash
curl -s -X POST "$APP_URL/api/v1/admin/historical-import/validate" \
  -H "Authorization: Bearer ***" -H 'Content-Type: application/json' \
  -d "{\"plan\": $(cat plan.json)}" | jq '.data.validation | {ok, plan_hash, snapshot_hash_pinned, destination_fingerprint, errors}'
```

5. Ensaio (não escreve nada):

```bash
curl -s -X POST "$APP_URL/api/v1/admin/historical-import/dry-run" \
  -H "Authorization: Bearer ***" -H 'Content-Type: application/json' \
  -d "{\"plan\": $(cat plan.json)}" | jq '.data.result | {operations_applied, operations_blocked, destination_fingerprint}'
```

6. Apply (exige `HISTORICAL_IMPORT_APPLY_ENABLED=true`, o hash confirmado **e** o fingerprint de estado do passo 5). Se a leitura do passo 5 já não corresponder ao estado atual (qualquer edição nativa entretanto), o apply responde 409 `destination-state-divergence` e não escreve: repetir 5→6.

```bash
HASH=<plan_hash do passo 4>
DEST=<destination_fingerprint do passo 5>
curl -s -X POST "$APP_URL/api/v1/admin/historical-import/apply" \
  -H "Authorization: Bearer ***" -H 'Content-Type: application/json' \
  -d "{\"plan\": $(cat plan.json), \"confirmed_plan_hash\": \"$HASH\", \"confirmed_destination_fingerprint\": \"$DEST\"}" | jq '.data.result'
```

7. Auditoria/verificação:

```bash
curl -s "$APP_URL/api/v1/admin/historical-import/audit?plan_hash=$HASH" -H "Authorization: Bearer ***" | jq
curl -s "$APP_URL/api/v1/admin/historical-import/provenance?entity_type=card&source_id=<trello_id>" -H "Authorization: Bearer ***" | jq
```

8. **Recuperação** (escolher uma via, por ordem de preferência):
   - **Re-executar apply** (idempotente) ou corrigir e re-aplicar: é o caminho normal e não destrói nada.
   - **Restore-based (garantido)**: restaurar o backup pré-apply; nenhuma linha foi apagada pela extensão, logo o restore é sempre válido. Não requer gates.
   - **Recuperação destrutiva limitada (sem restore)**: se o plano criou linhas que impedem a re-execução depois de um `reset`, e essas linhas são "folha" (nada nativo fora do plano depende delas):

```bash
curl -s -X POST "$APP_URL/api/v1/admin/historical-import/reset" \
  -H "Authorization: Bearer ***" -H 'Content-Type: application/json' \
  -d "{\"plan_hash\": \"$HASH\", \"recovery\": true, \"confirm_destructive\": true}" | jq
```

     Regras: exige OWNER, `HISTORICAL_IMPORT_RESET_RECOVERY_ENABLED=true` e `confirm_destructive=true`; apaga **apenas** as linhas que esse plano criou (proveniência `operation='create'`), dependentes primeiro, mais a proveniência do plano; recusa (409 `recovery-refused`, rollback total, nada apagado) se qualquer linha fora desse conjunto for afetada (FK não-cascade apontada a uma linha do plano, cascade que removeria linhas alheias, entidade desconhecida, ciclo de FK). Se um `reset` normal já limpou a proveniência, o conjunto a apagar é reconstruído a partir do `import_audit_log` (append-only) — a recuperação continua possível, mas convém fazer recovery **antes** de reset.

Via MCP (staging): `historical_import_validate`, `historical_import_dry_run`, `historical_import_reset` (provenance-only) — **apply e recuperação destrutiva são apenas REST**.

## Verificação executada nesta tarefa

Correção QA-3/QA-4/QA-6 (t_4974d8e5) — branch `fix/historical-import-join-state-reset`, commit próprio sobre `4d82e90`:

- `bun test tests/integration/historicalImport/ tests/unit/server/extensions/historicalImport/` → **92 pass / 0 fail** (49 herdados + 43 novos: chaves compostas, join tables, gates de estado/snapshot, reset/recuperação).
- Ensaio real em Postgres 16 (clone isolado restaurado do backup live, `chimedeck_qa5`; migração 0119 aplicada por `knex migrate:latest`): `qa/evidence/remediation-join-state-reset.json` — leitura e escrita de `card_label`/`card_member` por chave composta, idempotência (0 applied / 2 noop no re-run), proteção de linhas nativas, `link` composto, `snapshot-divergence` com snapshot trocado, `destination-state-divergence` com rename nativo, recuperação destrutiva (recusa com dependente nativo + sucesso após limpeza), dry-run sem escritas e contagens de tabelas intocadas no fim (231 cards / 99 card_labels / 30 card_members como no baseline). Sem tocar o live nem o Trello.
- `tsc --noEmit`: contagem de erros igual ao baseline do branch (nenhum novo introduzido pelos ficheiros desta correção).

## Verificação executada nesta tarefa

Correção de autorização de board create + cadeia create→cover enrich (t_741ef2c1) — branch `fix/historical-import-board-create-cover-chain-t741`, a partir do head exacto do PR #3 (`c41635b`):

- `bun test tests/integration/historicalImport tests/unit/server/extensions/historicalImport` → **119 pass / 0 fail** (102 herdados + 17 novos: 7 da cadeia de cover, 10 do testemunho de board create).
- `tsc --noEmit`: **175 erros, exactamente o mesmo número/ficheiros do baseline c41635b** (nenhum novo; nenhum em `historicalImport`).
- Ensaio real isolado em PostgreSQL 16.15 + MinIO (`qa/probe-t741.ts`, base de dados descartável `chimedeck_t741`, bucket local): **31/31 checks, 0 falhas** — testemunho de board create provado pelo payload+owner gate, recusa de workspace errado/autor não-owner/workspace inexistente/payload adulterado após o manifest/board desconhecido/plano multi-workspace; cadeia de cover ponta-a-ponta com dry-run sem escritas duráveis, apply, re-run no-op (3 noop, 0 applied, linha e claim inalteradas), cadeia `link` sobre cartão nativo, cover nativa preservada (enrich bloqueado), ensaio de filho (`card create` + `comment create`) agora verde, readback MinIO a recusar SHA errado, zero notificações. Evidência: `qa/evidence/t741-board-create-cover-chain.json`.
- Sem alterações de schema (nenhuma migração tocada) — o `import_provenance`/`import_audit_log` de 0119 mantêm-se; nada a reverter.
- Defeito encontrado pelo ensaio, **fora do âmbito destas duas correções** e encaminhado como tarefa própria (t_941b20c1, já corrigido): um payload staged com `created_at` em entidades cuja tabela não tem essa coluna (ex. `lists`) faz falhar o INSERT (`column "created_at" of relation "lists" does not exist`).

## Verificação executada nesta tarefa

Correção da projeção de timestamps para entidades sem colunas `created_at`/`updated_at` (t_941b20c1) — branch `fix/historical-import-timestamp-columns-t941`, a partir do head exacto do PR #3 (`3803bc8`):

- `bun test tests/integration/historicalImport tests/unit/server/extensions/historicalImport` → **132 pass / 0 fail** (119 herdados + 13 novos em `tests/unit/.../columns.test.ts`: metadata live + fail-closed quando não resolve, cache por tabela com falhas não memorizadas, projeção pura por classe de tabela, ausência de coluna homónima inventada, nenhuma leitura de schema quando não há timestamp declarado, propagação de falha da metadata).
- `tsc --noEmit`: **175 erros, exactamente o mesmo número do baseline 3803bc8** (84 ficheiros, nenhum em `historicalImport` ou nos ficheiros desta correção).
- **Reprodução do defeito antes da correção** (mesmo ensaio, checkout não modificado em `3803bc8`): `qa/evidence/t941-baseline-defect.json` → `dry-run preflight failed: insert into "lists" ("board_id", "created_at", "id", "position", "short_id", "title", "updated_at") … - column "created_at" of relation "lists" does not exist`; fail-fast deixou 1 op `failed` e as outras 7 `blocked` (20/26 checks vermelhos).
- Ensaio real isolado em PostgreSQL 16 + MinIO (`qa/probe-t941.ts`, base descartável `chimedeck_t941` com as 78 migrações, bucket local, TZ UTC): **28/28 checks, 0 falhas** — as três classes de schema verificadas contra a DB real; dry-run e apply materializam as 8 criações (list/card/checklist/checklist_item/comment/attachment FILE/label/activity) com paridade exacta de colunas por INSERT; `lists`/`checklist_items`/`labels` recebem o payload com timestamps declarados e ganham **zero** colunas de timestamp; `cards`/`checklists`/`comments`/`attachments` guardam os instantes históricos exactos (`2021-…`); `activities` guarda `created_at` e não ganha `updated_at`; nenhum INSERT alguma vez toca numa coluna inexistente do destino; as 7 omissões são reportadas uma única vez por entidade/campo por plan run (dry-run e apply); re-run é `8 noop / 0 applied` sem reescrever timestamps nem voltar a ler o schema; readback MinIO do objecto staged com SHA-256 a bater; zero notificações. Evidência: `qa/evidence/t941-timestamp-projection.json`.
- Sem alterações de schema (nenhuma migração tocada) — nada a reverter.

Baseline herdado (t_fd4bae8d): 49 testes da extensão, 175 erros `tsc` pré-existentes no upstream `20ee518` (o upstream não passa typecheck nem lint limpos), ESLint já falha `strictTypeChecked` nos próprios ficheiros.

## Riscos / notas para revisão

- `payload_ref` depende de ficheiro staged no host — o gerador de planos (etapa de planeamento/ensaio) tem de garantir que o root existe e os ficheiros correspondem ao plano (o hash do plano cobre as refs, não o conteúdo dos payloads; integridade do conteúdo é do snapshot `snapshot_hash`).
- Concorrência real em Postgres: `createWithProvenance` usa transação + verificação de provenance dentro da transação (o unique em `(source_system, entity_type, source_id)` é a última defesa; colisão `23505` é relida e resolvida como materialização existente).
- `reset` sem `recovery=true` continua a **não** apagar linhas de entidades, mas agora reporta explicitamente as linhas criadas que ficam (`created_targets_remaining`) e a nota de recuperação; a remoção dessas linhas exige `recovery=true` + `confirm_destructive=true` + `HISTORICAL_IMPORT_RESET_RECOVERY_ENABLED=true` e é restrita às linhas criadas por esse plan hash.
- A recuperação destrutiva lê o grafo de FK de `pg_constraint` em runtime (schema real, não lista fixa) e faz um post-condition de contagens em todas as tabelas alcançáveis por `CASCADE`: qualquer remoção fora do conjunto do plano faz rollback e devolve blockers. É específica de PostgreSQL (o projeto é Postgres-only).
- O `destination_fingerprint` cobre a linha inteira das entidades tocadas (incluindo colunas voláteis como `updated_at`/`search_vector` em tipos fora de `card`/`comment`): uma escrita nativa concorrente entre o dry-run e o apply faz recusar o apply (fail-closed). É intencional, mas implica repetir 5→6 em janelas com atividade.
- `import_audit_log` é append-only por desenho: ensaios e recuperações deixam rasto (não é removido por `reset`).
- O `dry-run` corre agora numa única transação de ensaio (savepoint por operação, rollback no fim). Vantagem: ensaia cadeias `create → filho` com o schema real e nada fica durável. Custo: a transação de ensaio é mais longa e mantém locks até ao fim do ensaio — em bases com escrita nativa concorrente, o ensaio pode bloquear/sofrer mais do que antes (e o `destination_fingerprint` continua a ser a autoridade da paridade de estado). Nada a reverter no schema.
- Projeção de timestamps: a metadata de colunas é lida do schema live **uma vez por tabela por plan run** (`createKnexDeps`), dentro do corpo partilhado por dry-run e apply — o custo é uma consulta a `information_schema.columns` por tabela tocada por plano (não por operação). A cache vive apenas o tempo de vida daquela instância de deps (um request/plano), por isso não pode ficar obsoleta entre migrações nem entre bases. Se a metadata não resolver, a operação falha (fail-closed) em vez de descartar história.
- A omissão de um timestamp declarado (coluna inexistente no destino) é reportada apenas no log do servidor (`console.warn`, uma vez por entidade/campo por plan run) — **não** entra no `import_audit_log`, cujo contrato não foi alargado. Um operador que precise do inventário de omissões para o relatório de fidelidade deve recolher essas linhas de log durante o apply.
- Chaves dentro de `payload.fields` continuam a ser copiadas verbatim para a linha: uma coluna mal escrita aí continua a falhar o INSERT (intencional — falha ruidosa em vez de descarte silencioso). Só o par `created_at`/`updated_at` de topo é projetado contra o schema real.
