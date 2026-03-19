import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Log context interface for correlation IDs and request tracing.
 */
export interface LogContext {
  correlationId?: string;
  agentId?: string;
  agentName?: string;
  issueId?: string;
  issueIdentifier?: string;
  runId?: string;
  userId?: string;
  companyId?: string;
}

const contextStorage = new AsyncLocalStorage<LogContext>();

/**
 * Get the current log context from async storage.
 */
export function getContext(): LogContext {
  return contextStorage.getStore() || {};
}

/**
 * Set values in the current log context.
 */
export function setContext(context: Partial<LogContext>): void {
  const store = contextStorage.getStore();
  if (store) {
    Object.assign(store, context);
  }
}

/**
 * Run a function with a specific log context.
 */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return contextStorage.run(context, fn);
}

/**
 * Get the current correlation ID.
 */
export function getCorrelationId(): string | undefined {
  return getContext().correlationId;
}

/**
 * Get agent context for logging.
 */
export function getAgentContext(): { agentId?: string; agentName?: string } {
  const ctx = getContext();
  return { agentId: ctx.agentId, agentName: ctx.agentName };
}

/**
 * Get issue context for logging.
 */
export function getIssueContext(): { issueId?: string; issueIdentifier?: string } {
  const ctx = getContext();
  return { issueId: ctx.issueId, issueIdentifier: ctx.issueIdentifier };
}

/**
 * Generate a new correlation ID.
 */
export function generateCorrelationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 9);
  return `pc_${timestamp}_${random}`;
}
