import { AGENT_ROLES } from "@zeroinc/shared";

const GENERATION_SYSTEM_PROMPT = `You are an agent profile generator for the ZeroInc platform. Given a user description of what they need, generate a specialized AI agent profile.

Output ONLY valid JSON with these exact fields:
- shortname: kebab-case identifier (max 30 chars, lowercase letters, numbers, hyphens)
- role: one of [${AGENT_ROLES.join(", ")}]
- displayName: human-readable name (max 50 chars)
- title: short job title or tagline (max 100 chars)
- systemPrompt: the agent system prompt — must include:
  - Clear role identity and expertise
  - Personality traits and communication style
  - Core mission (3-5 key responsibilities)
  - Critical rules to follow
  - Deliverable expectations
  - Max 2000 characters total
- capabilities: array of 3-8 capability strings

Guidelines:
- Be specific, not generic. "SEO Specialist" not "marketing person"
- Include domain-specific best practices in the system prompt
- Reference concrete frameworks/methodologies where applicable
- Keep the system prompt actionable and focused
- Choose the most appropriate role from the list
- Do not include any explanation or markdown formatting outside the JSON`;

interface GeneratedProfile {
  shortname: string;
  role: string;
  displayName: string;
  title: string;
  systemPrompt: string;
  capabilities: string[];
}

export class AgentProfileGeneratorError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentProfileGeneratorError";
  }
}

export async function generateAgentProfile(description: string): Promise<GeneratedProfile> {
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;

  if (!authToken) {
    throw new AgentProfileGeneratorError("ANTHROPIC_AUTH_TOKEN is not configured");
  }

  const url = `${baseUrl ?? "https://api.anthropic.com/v1"}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": authToken,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: GENERATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Generate an agent profile for: ${description}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AgentProfileGeneratorError(
      `Anthropic API returned ${response.status}: ${body}`,
    );
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const textBlock = data.content?.find((block) => block.type === "text");
  if (!textBlock?.text) {
    throw new AgentProfileGeneratorError("No text content in LLM response");
  }

  const raw = textBlock.text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new AgentProfileGeneratorError("LLM response did not contain valid JSON");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new AgentProfileGeneratorError("Failed to parse LLM JSON response");
  }

  const obj = parsed as Record<string, unknown>;
  const requiredFields = ["shortname", "role", "displayName", "title", "systemPrompt", "capabilities"] as const;
  for (const field of requiredFields) {
    if (!obj[field] || (typeof obj[field] === "string" && obj[field].trim().length === 0)) {
      throw new AgentProfileGeneratorError(`Generated profile missing field: ${field}`);
    }
  }

  return {
    shortname: String(obj.shortname),
    role: String(obj.role),
    displayName: String(obj.displayName),
    title: String(obj.title),
    systemPrompt: String(obj.systemPrompt).slice(0, 2000),
    capabilities: Array.isArray(obj.capabilities)
      ? (obj.capabilities as string[]).map(String)
      : [],
  };
}
