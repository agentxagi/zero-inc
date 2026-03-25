import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { agents, goals, issues } from "@zeroinc/db";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getDefaultCompanyGoal } from "./goals.js";

type GoalLike = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  level: string;
};

type IssueLike = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  originKind: string;
  goalId: string | null;
  updatedAt: Date;
  completedAt: Date | null;
  reviewCount: number;
};

type AgentLike = {
  id: string;
  name: string;
  role: string;
  status: string;
};

type OutcomeMilestoneDefinition = {
  id: string;
  pillar: "open_source" | "enterprise" | "operating_model";
  title: string;
  patterns: RegExp[];
  minEvidence: number;
};

const OPERATIONS_PREFIXES = new Set(["OPS", "SYSTEM", "AUDIT", "REVIEW", "ONGOING"]);
const OPERATIONS_TITLE_PATTERNS = [
  /\bstale\b/i,
  /watchdog/i,
  /health check/i,
  /inbox unchanged/i,
  /review and post approved content/i,
];

const OUTCOME_MILESTONES: OutcomeMilestoneDefinition[] = [
  {
    id: "oss-readme-landing",
    pillar: "open_source",
    title: "README e landing page profissionais",
    patterns: [/readme/i, /landing/i, /open source/i],
    minEvidence: 1,
  },
  {
    id: "oss-quickstart-onboarding",
    pillar: "open_source",
    title: "Onboarding/quickstart em menos de 5 minutos",
    patterns: [/quick.?start/i, /onboard/i, /5 ?min/i, /smoke test/i],
    minEvidence: 1,
  },
  {
    id: "oss-docs-api-deploy",
    pillar: "open_source",
    title: "Documentação de API e deploy publicável",
    patterns: [/\[docs\]/i, /documentation/i, /guide/i, /api auth/i, /deployment/i, /docker/i],
    minEvidence: 1,
  },
  {
    id: "ent-auth-hardening",
    pillar: "enterprise",
    title: "Autenticação e autorização endurecidas",
    patterns: [/auth/i, /api key/i, /jwt/i, /permission/i, /board token/i],
    minEvidence: 1,
  },
  {
    id: "ent-production-deploy",
    pillar: "enterprise",
    title: "Deploy production-ready (Docker/systemd)",
    patterns: [/docker/i, /systemd/i, /production/i, /deploy/i],
    minEvidence: 1,
  },
  {
    id: "ent-multi-company-governance",
    pillar: "enterprise",
    title: "Isolamento multi-company com governança",
    patterns: [/multi[- ]company/i, /tenant/i, /governance/i, /approval/i, /isolation/i],
    minEvidence: 1,
  },
  {
    id: "ent-monitoring-watchdog",
    pillar: "enterprise",
    title: "Monitoramento/watchdog confiáveis",
    patterns: [/watchdog/i, /monitor/i, /health/i, /sre/i],
    minEvidence: 1,
  },
  {
    id: "ent-scalability-runtime",
    pillar: "enterprise",
    title: "Escalabilidade (queue/pooling/runtime)",
    patterns: [/queue/i, /pool/i, /scalab/i, /runtime/i, /worktree/i],
    minEvidence: 1,
  },
  {
    id: "ops-review-pipeline",
    pillar: "operating_model",
    title: "Review pipeline e quality gate confiáveis",
    patterns: [/review pipeline/i, /quality gate/i, /in_review/i],
    minEvidence: 1,
  },
  {
    id: "ops-proactive-planning",
    pillar: "operating_model",
    title: "Planejamento proativo de produto em ciclo contínuo",
    patterns: [/sprint planning/i, /goal breakdown/i, /proactive/i, /product council/i],
    minEvidence: 1,
  },
];

const COUNCIL_TEAM_MODEL = {
  source: "companies.sh/docs",
  principles: [
    "COMPANY.md define objetivo e escopo",
    "agents/*/AGENTS.md define papéis e cadeia de decisão",
    "skills/*/SKILL.md define comportamento especializado",
    "projetos e tarefas evoluem continuamente em ciclos",
  ],
};

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function extractPrefix(title: string): string | null {
  const match = title.match(/^\s*\[([^\]]+)\]/);
  return match ? match[1]!.trim().toUpperCase() : null;
}

export function isOperationalNoiseIssue(issue: Pick<IssueLike, "title" | "originKind">): boolean {
  if (issue.originKind === "routine_execution") return true;
  const prefix = extractPrefix(issue.title);
  if (prefix && OPERATIONS_PREFIXES.has(prefix)) return true;
  return OPERATIONS_TITLE_PATTERNS.some((pattern) => pattern.test(issue.title));
}

function normalizeIssueText(issue: Pick<IssueLike, "title" | "description">): string {
  return `${issue.title}\n${issue.description ?? ""}`.toLowerCase();
}

function hasPatternMatch(issue: Pick<IssueLike, "title" | "description">, patterns: RegExp[]): boolean {
  const text = normalizeIssueText(issue);
  return patterns.some((pattern) => pattern.test(text));
}

function computeMilestones(doneIssues: IssueLike[]) {
  const rows = OUTCOME_MILESTONES.map((milestone) => {
    const evidence = doneIssues.filter((issue) => hasPatternMatch(issue, milestone.patterns));
    const evidenceIds = evidence
      .map((issue) => issue.identifier)
      .filter((value): value is string => Boolean(value))
      .slice(0, 5);
    const status =
      evidence.length >= milestone.minEvidence
        ? "done"
        : evidence.length > 0
          ? "partial"
          : "missing";
    return {
      id: milestone.id,
      pillar: milestone.pillar,
      title: milestone.title,
      status,
      evidenceCount: evidence.length,
      evidenceIssueIds: evidenceIds,
    };
  });

  const score = rows.reduce((acc, row) => {
    if (row.status === "done") return acc + 1;
    if (row.status === "partial") return acc + 0.5;
    return acc;
  }, 0);
  const maxScore = rows.length || 1;
  const completionPercent = Math.round((score / maxScore) * 100);
  return { rows, completionPercent };
}

function pickAgentByRole(agentRows: AgentLike[], roleCandidates: string[]) {
  for (const role of roleCandidates) {
    const found = agentRows.find((agent) => agent.role === role);
    if (found) return found;
  }
  return null;
}

type ProposalBlueprint = {
  title: string;
  priority: "critical" | "high" | "medium" | "low";
  ownerRoles: string[];
  keywords: string[];
  description: string;
  definitionOfDone: string[];
};

const PROPOSAL_BLUEPRINTS: Record<string, ProposalBlueprint> = {
  "oss-readme-landing": {
    title: "[OPEN SOURCE] Consolidar README + landing com narrativa única do produto",
    priority: "high",
    ownerRoles: ["designer", "pm", "engineer"],
    keywords: ["readme", "landing"],
    description:
      "Unificar posicionamento do produto no README e na landing, removendo drift entre promessa e implementação atual.",
    definitionOfDone: [
      "README atualizado com quickstart verificável e proposta de valor objetiva.",
      "Landing alinhada com as mesmas mensagens e CTAs.",
      "Smoke check de links e comandos documentados.",
    ],
  },
  "oss-quickstart-onboarding": {
    title: "[OPEN SOURCE] Quickstart 5-min com verificação ponta-a-ponta",
    priority: "high",
    ownerRoles: ["engineer", "pm"],
    keywords: ["quickstart", "onboarding"],
    description:
      "Criar e validar um fluxo de onboarding de primeiro uso com tempo alvo de 5 minutos e evidência objetiva.",
    definitionOfDone: [
      "Passo a passo reproduzível em ambiente limpo.",
      "Checklist automatizado de saúde após setup.",
      "Evidência (logs/comandos) anexada na issue.",
    ],
  },
  "oss-docs-api-deploy": {
    title: "[DOCS] Guia oficial de autenticação e deploy (board + agent)",
    priority: "medium",
    ownerRoles: ["pm", "engineer"],
    keywords: ["auth", "deployment", "docker", "systemd"],
    description:
      "Fechar lacuna de documentação operacional para uso OSS e self-host enterprise.",
    definitionOfDone: [
      "Guia cobre autenticação board e agent API keys.",
      "Guia cobre deploy Docker e service restart seguro.",
      "Comandos testados em ambiente real.",
    ],
  },
  "ent-auth-hardening": {
    title: "[ENTERPRISE] Hardening de autenticação/autorização cross-company",
    priority: "high",
    ownerRoles: ["cto", "engineer", "qa"],
    keywords: ["auth", "permission", "cross-company", "jwt"],
    description:
      "Revisar e endurecer fluxos de auth para evitar bypass e acesso indevido entre empresas/agentes.",
    definitionOfDone: [
      "Matriz de permissões revisada e coberta por testes.",
      "Testes negativos para isolamento entre companies.",
      "Checklist de segurança documentado.",
    ],
  },
  "ent-production-deploy": {
    title: "[INFRA] Baseline de deploy production-ready (Docker/systemd)",
    priority: "high",
    ownerRoles: ["devops", "cto"],
    keywords: ["docker", "systemd", "deploy"],
    description:
      "Padronizar operação de produção com observabilidade mínima, restart seguro e runbook.",
    definitionOfDone: [
      "Runbook de restart/rollback documentado.",
      "Healthchecks validados pós-deploy.",
      "Configuração versionada e testada em staging.",
    ],
  },
  "ent-multi-company-governance": {
    title: "[ENTERPRISE] Auditoria de isolamento multi-company + governança",
    priority: "high",
    ownerRoles: ["cto", "qa", "engineer"],
    keywords: ["multi-company", "tenant", "governance", "approval"],
    description:
      "Auditar boundaries de tenant e fluxos de aprovação para garantir separação estrita por company.",
    definitionOfDone: [
      "Cenários de acesso cruzado cobertos por teste.",
      "Rotas críticas com assert de company revisadas.",
      "Relatório de gaps e correções anexado.",
    ],
  },
  "ent-monitoring-watchdog": {
    title: "[INFRA] Confiabilidade de watchdog/monitoramento com alertas acionáveis",
    priority: "high",
    ownerRoles: ["devops", "engineer"],
    keywords: ["watchdog", "monitor", "health"],
    description:
      "Eliminar ruído operacional repetitivo e focar alertas em problemas realmente acionáveis.",
    definitionOfDone: [
      "Regras de alerta deduplicadas e documentadas.",
      "Falhas de monitor sem ação automática removidas.",
      "Dashboard de saúde com sinais prioritários.",
    ],
  },
  "ent-scalability-runtime": {
    title: "[FEATURE] Escalabilidade de runtime (queue/pooling/workspaces)",
    priority: "medium",
    ownerRoles: ["cto", "engineer", "devops"],
    keywords: ["queue", "pooling", "runtime", "worktree"],
    description:
      "Preparar runtime para crescimento contínuo sem degradação por acúmulo de sessões/processos.",
    definitionOfDone: [
      "Métricas de concorrência e saturação coletadas.",
      "Estratégia de pooling/cleanup validada sob carga.",
      "Teste de regressão para processos órfãos.",
    ],
  },
  "ops-review-pipeline": {
    title: "[BUG] Fechar gaps remanescentes do review pipeline/quality gate",
    priority: "high",
    ownerRoles: ["qa", "engineer", "cto"],
    keywords: ["review pipeline", "quality gate", "in_review"],
    description:
      "Garantir que nenhuma tarefa de engenharia escape de revisão formal com evidência verificável.",
    definitionOfDone: [
      "Caminhos de bypass cobertos por teste.",
      "Transições in_review -> done auditáveis.",
      "Critérios de bloqueio revisados e estáveis.",
    ],
  },
  "ops-proactive-planning": {
    title: "[PRODUCT] Ciclo contínuo de geração de tarefas orientadas a objetivo",
    priority: "high",
    ownerRoles: ["pm", "cto"],
    keywords: ["proactive", "product council", "goal"],
    description:
      "Instituir um ciclo permanente de planejamento orientado por objetivos e evidências de entrega real.",
    definitionOfDone: [
      "Council gera propostas com DoD e owner sugerido.",
      "Geração bloqueia quando já existe execução relevante em andamento.",
      "Métrica de outcome exposta para o board.",
    ],
  },
};

function hasOpenIssueForKeywords(openIssues: IssueLike[], keywords: string[]): boolean {
  return openIssues.some((issue) => {
    const text = normalizeIssueText(issue);
    return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
  });
}

function countRecentOutputs(days = 7, root = "/opt/paperclip/outputs", now = new Date()): number {
  if (!existsSync(root)) return 0;
  let total = 0;
  for (let i = 0; i < days; i += 1) {
    const day = addDays(now, -i);
    const dirName = day.toISOString().slice(0, 10);
    const dirPath = join(root, dirName);
    if (!existsSync(dirPath)) continue;
    const files = readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile()) total += 1;
    }
  }
  return total;
}

export function buildProductCouncilReport(input: {
  companyId: string;
  goal: GoalLike | null;
  goalDoneIssues: IssueLike[];
  goalOpenIssues: IssueLike[];
  companyOpenIssues: IssueLike[];
  agentRows: AgentLike[];
  outputsLast7Days: number;
  now?: Date;
  maxProposals?: number;
}) {
  const now = input.now ?? new Date();
  const maxProposals = Math.min(Math.max(input.maxProposals ?? 5, 1), 8);

  const issueBasedTotal = input.goalDoneIssues.length + input.goalOpenIssues.length;
  const issueBasedPercent = issueBasedTotal > 0
    ? Math.round((input.goalDoneIssues.length / issueBasedTotal) * 100)
    : 0;

  const milestoneSummary = computeMilestones(input.goalDoneIssues);
  const missingMilestones = milestoneSummary.rows.filter((row) => row.status !== "done");

  const goalOpenByStatus = {
    backlog: input.goalOpenIssues.filter((issue) => issue.status === "backlog").length,
    todo: input.goalOpenIssues.filter((issue) => issue.status === "todo").length,
    in_progress: input.goalOpenIssues.filter((issue) => issue.status === "in_progress").length,
    in_review: input.goalOpenIssues.filter((issue) => issue.status === "in_review").length,
    blocked: input.goalOpenIssues.filter((issue) => issue.status === "blocked").length,
  };

  const executionActive = input.companyOpenIssues.filter((issue) =>
    (issue.status === "todo" || issue.status === "in_progress" || issue.status === "blocked") &&
    !isOperationalNoiseIssue(issue),
  );
  const executionBacklog = input.companyOpenIssues.filter((issue) =>
    issue.status === "backlog" && !isOperationalNoiseIssue(issue),
  );
  const backlogStaleCutoff = addDays(now, -3);
  const staleExecutionBacklog = executionBacklog.filter((issue) => issue.updatedAt < backlogStaleCutoff);
  const done24hCutoff = addDays(now, -1);
  const doneLast24h = input.goalDoneIssues.filter((issue) => issue.completedAt && issue.completedAt > done24hCutoff).length;

  const reviewedEngineeringDone = input.goalDoneIssues.filter((issue) => {
    const prefix = extractPrefix(issue.title);
    const engineeringPrefix = prefix != null
      && new Set(["BUG", "FEATURE", "CODE", "INFRA", "SHIP", "ENTERPRISE", "OPEN SOURCE", "BUILD"]).has(prefix);
    return engineeringPrefix && issue.reviewCount > 0;
  }).length;
  const totalEngineeringDone = input.goalDoneIssues.filter((issue) => {
    const prefix = extractPrefix(issue.title);
    return prefix != null
      && new Set(["BUG", "FEATURE", "CODE", "INFRA", "SHIP", "ENTERPRISE", "OPEN SOURCE", "BUILD"]).has(prefix);
  }).length;
  const reviewCoveragePercent = totalEngineeringDone > 0
    ? Math.round((reviewedEngineeringDone / totalEngineeringDone) * 100)
    : null;

  const pmAgent = pickAgentByRole(input.agentRows, ["pm"]);
  const ctoAgent = pickAgentByRole(input.agentRows, ["cto", "engineer"]);
  const reviewerAgent = pickAgentByRole(input.agentRows, ["qa", "reviewer"]);

  const councilDiscussion = [
    {
      role: "pm",
      speaker: pmAgent?.name ?? "PM",
      summary:
        executionActive.length > 0
          ? `Há ${executionActive.length} tarefa(s) de execução ativas; foco deve ser fluxo e destravamento.`
          : "Pipeline de execução está ocioso; é seguro propor próximas entregas estratégicas.",
      concerns: [
        `Backlog de execução não-operacional: ${executionBacklog.length}`,
        `Milestones pendentes/parciais: ${missingMilestones.length}`,
      ],
      recommendation:
        executionActive.length > 0
          ? "Priorizar conclusão/desbloqueio antes de abrir novos streams."
          : "Gerar até 2 tarefas novas com DoD claro e owner definido.",
    },
    {
      role: "cto",
      speaker: ctoAgent?.name ?? "CTO",
      summary: "Priorizar lacunas técnicas com maior impacto em Open Source + Enterprise.",
      concerns: missingMilestones
        .filter((item) => item.pillar === "enterprise")
        .slice(0, 3)
        .map((item) => item.title),
      recommendation: "Focar primeiro em hardening de plataforma e confiabilidade operacional.",
    },
    {
      role: "reviewer",
      speaker: reviewerAgent?.name ?? "Code Reviewer",
      summary:
        reviewCoveragePercent == null
          ? "Sem amostra suficiente de tarefas de engenharia concluídas para medir cobertura de review."
          : `Cobertura de review em tarefas de engenharia concluídas: ${reviewCoveragePercent}%.`,
      concerns: [
        input.outputsLast7Days > 0
          ? `${input.outputsLast7Days} artefatos encontrados em /opt/paperclip/outputs nos últimos 7 dias.`
          : "Nenhum artefato encontrado em /opt/paperclip/outputs nos últimos 7 dias.",
      ],
      recommendation: "Toda proposta nova precisa incluir evidência verificável de entrega no DoD.",
    },
  ];

  const proposals: Array<{
    id: string;
    sourceMilestoneId: string;
    title: string;
    description: string;
    priority: "critical" | "high" | "medium" | "low";
    suggestedOwnerRole: string | null;
    suggestedAssigneeAgentId: string | null;
    suggestedAssigneeName: string | null;
    definitionOfDone: string[];
  }> = [];

  if (staleExecutionBacklog.length > 0) {
    const owner = pickAgentByRole(input.agentRows, ["pm", "cto"]);
    proposals.push({
      id: "stale-backlog-retriage",
      sourceMilestoneId: "ops-proactive-planning",
      title: "[PRODUCT] Re-triagem de backlog estagnado para sprint executável",
      description:
        `Existem ${staleExecutionBacklog.length} tarefa(s) de backlog de execução sem atualização há mais de 72h. ` +
        "Converter as relevantes em todo com owner, prioridade e DoD explícitos.",
      priority: "high",
      suggestedOwnerRole: owner?.role ?? null,
      suggestedAssigneeAgentId: owner?.id ?? null,
      suggestedAssigneeName: owner?.name ?? null,
      definitionOfDone: [
        "Revisar backlog estagnado e cancelar itens irrelevantes.",
        "Promover até 3 itens para todo com assignee e prioridade.",
        "Cada item promovido deve conter DoD verificável.",
      ],
    });
  }

  for (const milestone of missingMilestones) {
    const blueprint = PROPOSAL_BLUEPRINTS[milestone.id];
    if (!blueprint) continue;
    if (hasOpenIssueForKeywords(input.companyOpenIssues, blueprint.keywords)) continue;
    const owner = pickAgentByRole(input.agentRows, blueprint.ownerRoles);
    proposals.push({
      id: `proposal-${milestone.id}`,
      sourceMilestoneId: milestone.id,
      title: blueprint.title,
      description: `${blueprint.description}\n\nContexto do council: milestone "${milestone.title}" está ${milestone.status}.`,
      priority: blueprint.priority,
      suggestedOwnerRole: owner?.role ?? null,
      suggestedAssigneeAgentId: owner?.id ?? null,
      suggestedAssigneeName: owner?.name ?? null,
      definitionOfDone: blueprint.definitionOfDone,
    });
    if (proposals.length >= maxProposals) break;
  }

  let shouldGenerate = false;
  let gateReason = "Sem propostas elegíveis.";
  if (executionActive.length > 0) {
    shouldGenerate = false;
    gateReason = `Existem ${executionActive.length} tarefa(s) de execução ativa(s) (todo/in_progress/blocked).`;
  } else if (executionBacklog.length > 0 && staleExecutionBacklog.length !== executionBacklog.length) {
    shouldGenerate = false;
    gateReason =
      `Há ${executionBacklog.length} tarefa(s) de backlog de execução ainda recentes; ` +
      "priorize esse backlog antes de gerar novas tarefas.";
  } else if (proposals.length > 0) {
    shouldGenerate = true;
    gateReason = "Pipeline de execução está ocioso e há lacunas de milestone com propostas claras.";
  }

  return {
    timestamp: now.toISOString(),
    companyId: input.companyId,
    teamModel: COUNCIL_TEAM_MODEL,
    goal: input.goal
      ? {
        id: input.goal.id,
        title: input.goal.title,
        status: input.goal.status,
        level: input.goal.level,
      }
      : null,
    workload: {
      companyOpenIssues: input.companyOpenIssues.length,
      executionActive: executionActive.length,
      executionBacklog: executionBacklog.length,
      staleExecutionBacklog: staleExecutionBacklog.length,
      goalOpenByStatus,
    },
    progress: {
      issueBasedPercent,
      outcomeBasedPercent: milestoneSummary.completionPercent,
      doneIssues: input.goalDoneIssues.length,
      openIssues: input.goalOpenIssues.length,
      doneLast24h,
      reviewCoveragePercent,
      outputsLast7Days: input.outputsLast7Days,
    },
    milestones: milestoneSummary.rows,
    councilDiscussion,
    gating: {
      shouldGenerate,
      reason: gateReason,
    },
    proposals: proposals.slice(0, maxProposals),
  };
}

async function resolveGoalForCouncil(db: Db, companyId: string, goalId?: string | null): Promise<GoalLike | null> {
  if (goalId) {
    const explicit = await db
      .select()
      .from(goals)
      .where(and(eq(goals.id, goalId), eq(goals.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    return explicit;
  }

  const latestActiveRoot = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(desc(goals.updatedAt), desc(goals.createdAt))
    .then((rows) => rows[0] ?? null);

  if (latestActiveRoot) return latestActiveRoot;
  return getDefaultCompanyGoal(db, companyId);
}

export function productCouncilService(db: Db) {
  return {
    analyze: async (
      companyId: string,
      opts?: { goalId?: string | null; maxProposals?: number; now?: Date },
    ) => {
      const now = opts?.now ?? new Date();
      const goal = await resolveGoalForCouncil(db, companyId, opts?.goalId ?? null);
      const childGoalIds = goal
        ? await db
          .select({ id: goals.id })
          .from(goals)
          .where(eq(goals.parentId, goal.id))
          .then((rows) => rows.map((row) => row.id))
        : [];
      const scopedGoalIds = goal ? [goal.id, ...childGoalIds] : [];

      const goalDoneIssues = scopedGoalIds.length > 0
        ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
            status: issues.status,
            priority: issues.priority,
            originKind: issues.originKind,
            goalId: issues.goalId,
            updatedAt: issues.updatedAt,
            completedAt: issues.completedAt,
            reviewCount: issues.reviewCount,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              inArray(issues.goalId, scopedGoalIds),
              eq(issues.status, "done"),
              isNull(issues.hiddenAt),
            ),
          )
        : [];

      const goalOpenIssues = scopedGoalIds.length > 0
        ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
            status: issues.status,
            priority: issues.priority,
            originKind: issues.originKind,
            goalId: issues.goalId,
            updatedAt: issues.updatedAt,
            completedAt: issues.completedAt,
            reviewCount: issues.reviewCount,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              inArray(issues.goalId, scopedGoalIds),
              inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
              isNull(issues.hiddenAt),
            ),
          )
        : [];

      const companyOpenIssues = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          priority: issues.priority,
          originKind: issues.originKind,
          goalId: issues.goalId,
          updatedAt: issues.updatedAt,
          completedAt: issues.completedAt,
          reviewCount: issues.reviewCount,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(desc(issues.updatedAt))
        .limit(300);

      const agentRows = await db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          status: agents.status,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId));

      const outputsLast7Days = countRecentOutputs(7, "/opt/paperclip/outputs", now);

      return buildProductCouncilReport({
        companyId,
        goal,
        goalDoneIssues,
        goalOpenIssues,
        companyOpenIssues,
        agentRows,
        outputsLast7Days,
        now,
        maxProposals: opts?.maxProposals,
      });
    },
  };
}

