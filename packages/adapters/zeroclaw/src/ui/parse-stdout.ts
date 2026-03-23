import type { TranscriptEntry } from "@zeroinc/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseZeroClawStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // ZeroClaw worker status lines
  if (trimmed.startsWith("[zeroclaw]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[zeroclaw\]\s*/, "") }];
  }

  if (trimmed.startsWith("[zeroclaw:error]")) {
    return [{ kind: "stderr", ts, text: trimmed.replace(/^\[zeroclaw:error\]\s*/, "") }];
  }

  // Try parsing as structured JSON event
  const parsed = safeJsonParse(trimmed);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.kind === "string") {
      const entry: Record<string, unknown> = { kind: obj.kind, ts };
      if (typeof obj.text === "string") entry.text = obj.text;
      if (typeof obj.delta === "boolean") entry.delta = obj.delta;
      if (typeof obj.name === "string") entry.name = obj.name;
      if (obj.input !== undefined) entry.input = obj.input;
      if (typeof obj.toolUseId === "string") entry.toolUseId = obj.toolUseId;
      if (typeof obj.content === "string") entry.content = obj.content;
      if (typeof obj.isError === "boolean") entry.isError = obj.isError;
      return [entry as TranscriptEntry];
    }
  }

  return [{ kind: "stdout", ts, text: trimmed }];
}
