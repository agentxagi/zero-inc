# Estudo: O que implementar no ZeroInc a partir dos modelos companies.sh

Data: 2026-03-25
Status: Proposta priorizada para execução
Escopo: Evolução do ZeroInc para aumentar entrega real, reduzir loops operacionais e melhorar autonomia com governança

## 1. Resumo executivo

Os modelos de maior qualidade no `companies.sh` convergem em 4 padrões:

1. Pipeline com fases explícitas (discovery -> plan -> build -> review -> ship).
2. Geração proativa de trabalho orientada por objetivo e fontes reais.
3. Gates de qualidade com especialistas e critérios verificáveis.
4. Forte disciplina de handoff entre agentes, com evidência de entrega.

O ZeroInc já possui base sólida (review pipeline, quality gate, routines, dashboards), mas ainda sofre com:

1. Medição de progresso por heurística fraca (keywords/títulos), gerando falsa percepção de avanço.
2. PM/ops entrando em loop de manutenção quando faltam tarefas concretas de produto.
3. Falta de contrato estruturado para "depende de humano", dificultando autonomia saudável.
4. Risco operacional em ciclo de vida de processos locais (ex.: acúmulo de `claude --tools`).

## 2. Evidências principais

## 2.1 Padrões dos modelos companies.sh

1. `gstack` e `superpowers` forçam fases separadas por papel e responsabilidade.
2. `agentsys-engineering` explicita task discovery contínuo e phase gates.
3. `redoak-review` e `trail-of-bits-security` usam revisão especializada com triagem rigorosa.
4. `taches-creative` enfatiza metodologia e qualidade de workflow/skills.

## 2.2 Situação atual no ZeroInc

1. Product Council já existe e gera propostas, mas a leitura de progresso depende de matching por texto e não de entregável estruturado.
Arquivo: `server/src/services/product-council.ts`
2. Quality Gate já bloqueia completion sem evidência mínima, porém baseada em comentários/keywords.
Arquivo: `server/src/services/quality-gate.ts`
3. Review pipeline já está formalizado e com ciclos de revisão.
Arquivo: `server/src/services/review-pipeline.ts`
4. Detecção de stale hoje é majoritariamente aviso por comentário, sem orquestração robusta de recovery.
Arquivo: `server/src/services/stale-detection.ts`
5. Heartbeat já repara parte de órfãos, mas ainda existe janela para processos locais sobreviverem e consumir RAM.
Arquivo: `server/src/services/heartbeat.ts`

## 3. Recomendações priorizadas

## 3.0 Status de execução (2026-03-25)

1. P0.1 Outcome Ledger + gates de entregável: implementado.
2. P0.2 Discovery Engine + estoque por pilar: implementado.
3. P0.3 Contrato explícito de bloqueio humano + inbox SLA: implementado.
4. P0.4 Guardião de ciclo de vida de processos locais: implementado (watchdog com limiares de pressão, auto-remediação de detached stale e telemetria por run/pid).
5. P1.1 Phase Gate Engine (transições permitidas + fase explícita por task): implementado.

## P0 (executar agora)

1. Outcome Ledger (entregável real como fonte de verdade)
- Objetivo: progresso não pode depender de título/keyword.
- Implementação:
  - Exigir `issue_work_products` em tarefas de produto/engenharia para transição final de `done`.
  - Calcular milestones por work products + aprovação de review, não por texto da issue.
  - Expor no dashboard: `% com entregável verificável`, `% sem entregável`.
- Impacto: elimina "done fake" e "quase 100% sem output real".

2. Discovery Engine para backlog contínuo
- Objetivo: evitar board morto e loops de OPS sem evolução de produto.
- Implementação:
  - Novo serviço de descoberta com fontes configuráveis (issues internas, bugs recorrentes, metas sem cobertura, drift doc/code).
  - Dedupe por fingerprint semântico (title+goal+ownerRole+source).
  - Política de estoque mínimo de execução por pilar (`open_source`, `enterprise`, `operating_model`).
- Impacto: mantém fluxo de tarefas concretas sem depender de intervenção manual contínua.

3. Contrato explícito de bloqueio humano
- Objetivo: autonomia máxima com exceções humanas claras.
- Implementação:
  - Campo estruturado em issue para `blocked_by_human` + `human_action_type` + `resolution_hint`.
  - Inbox humano dedicada com SLA e ordenação por impacto.
  - PM proibido de marcar done/cancelled tarefas que exigiam ação humana sem evidência de resolução.
- Impacto: agentes seguem autônomos onde podem e escalam só o necessário.

4. Guardião de ciclo de vida de processos locais
- Objetivo: impedir novo acúmulo massivo de processos de agente.
- Implementação:
  - Processo watchdog por adapter local: detectar `detached/alive` por tempo ocioso e encerrar de forma segura.
  - Telemetria de `run_id -> pid -> started_at -> last_heartbeat`.
  - Alerta e auto-remediação quando RAM/process-count ultrapassar limiares.
- Impacto: reduz risco de starvation de memória e swap thrash.

## P1 (próxima sprint)

1. Phase Gate Engine formal (estilo agentsys/superpowers)
- Introduzir fases explícitas por tarefa (`discovery`, `planning`, `implementation`, `review`, `release`) com transições permitidas.
- Benefício: reduz retrabalho e aumenta previsibilidade.

2. Reviewer specialization lanes
- Lane de review por tipo (`code`, `security`, `ux`, `ops`) com SLA separado.
- Benefício: qualidade maior e menor gargalo em revisor genérico.

3. PM anti-loop hardening
- Regras explícitas para evitar heartbeat "sem ação":
  - se inbox inalterada N ciclos e milestones faltando -> gerar tarefa concreta obrigatória;
  - limitação de criação de OPS meta-task repetida.
- Benefício: PM deixa de apenas reportar estado e passa a produzir avanço.

## P2 (evolução contínua)

1. Programas permanentes por objetivo macro
- Estrutura de programas infinitos (Open Source, Enterprise, Operating Model) com metas trimestrais renováveis.

2. Debate de propostas entre agentes especialistas
- Antes de abrir tarefa grande, executar rodada curta de debate (PM/CTO/QA/Researcher) para elevar qualidade da proposta.

3. Métrica de valor entregue
- Score semanal por entregáveis reais + impacto + tempo de ciclo, separado de OPS.

## 4. Ordem sugerida de implementação

1. Outcome Ledger + ajustes no Product Council (P0.1)  
2. Guardião de processos locais (P0.4)  
3. Contrato de bloqueio humano (P0.3)  
4. Discovery Engine com estoque mínimo por pilar (P0.2)  
5. Phase Gate Engine (P1.1)

## 5. Critérios de sucesso (30 dias)

1. `outputs` e/ou `issue_work_products` com crescimento semanal consistente.
2. Zero dia com board sem `todo/in_progress` de produto.
3. Redução de tarefas OPS meta para menos de 20% do total concluído.
4. Queda de cancelamento para menos de 15%.
5. Sem recorrência de explosão de processos locais órfãos.

## 6. Conclusão

A direção correta não é aumentar quantidade de agentes; é endurecer o sistema de geração e validação de trabalho real. O ZeroInc já tem bons blocos de governança. O próximo salto é transformar esses blocos em um ciclo contínuo de entrega verificável, com autonomia alta e escalonamento humano explícito.
