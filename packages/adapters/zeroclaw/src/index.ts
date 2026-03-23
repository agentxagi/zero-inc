export const type = "zeroclaw";
export const label = "ZeroClaw";

export const models: { id: string; label: string }[] = [
  { id: "glm-5-turbo", label: "GLM-5 Turbo" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "claude-opus-4", label: "Claude Opus 4" },
];

export const agentConfigurationDoc = `# ZeroClaw Adapter

Adapter: zeroclaw

Use when:
- You want ZeroInc to dispatch tasks to a ZeroClaw agent runtime via HTTP.
- You need full agent capabilities (tools, memory, RAG, MCP, 25+ channels).

Don't use when:
- ZeroClaw gateway is not running or unreachable.
- You need a lightweight HTTP-only integration (use the \`http\` adapter).

Required config fields:
- \`gatewayUrl\` (string): ZeroClaw gateway base URL (e.g., "http://localhost:42617").
- \`apiKey\` (string): ZeroClaw API bearer token (from pairing or config).

Optional config fields:
- \`timeoutSec\` (number): Task timeout in seconds (default: 600).
- \`model\` (string): Override the model for this agent's tasks.
`;
