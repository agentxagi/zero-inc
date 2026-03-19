import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import type { Request, Response, NextFunction } from "express";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { runWithContext, generateCorrelationId, getContext } from "../logging/context.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export const logger = pino({
  level: "debug",
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "debug",
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    const logContext = getContext();
    const props: Record<string, unknown> = {
      correlationId: logContext.correlationId,
    };

    if (logContext.agentId) props.agentId = logContext.agentId;
    if (logContext.agentName) props.agentName = logContext.agentName;
    if (logContext.issueId) props.issueId = logContext.issueId;
    if (logContext.issueIdentifier) props.issueIdentifier = logContext.issueIdentifier;
    if (logContext.runId) props.runId = logContext.runId;
    if (logContext.companyId) props.companyId = logContext.companyId;

    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          ...props,
          errorContext: ctx.error,
          reqBody: ctx.reqBody,
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = body;
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = params;
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = query;
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
    }
    return props;
  },
});

/**
 * Express middleware that sets up correlation ID and log context for each request.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction) {
  const correlationId =
    (req.headers["x-correlation-id"] as string) ||
    (req.headers["x-request-id"] as string) ||
    generateCorrelationId();

  const context = {
    correlationId,
    companyId: (req as any).company?.id,
    userId: (req as any).user?.id,
  };

  res.setHeader("X-Correlation-Id", correlationId);

  runWithContext(context, () => {
    next();
  });
}

/**
 * Middleware to set agent context in log context.
 */
export function agentContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  const agent = (req as any).agent;
  if (agent) {
    const ctx = getContext();
    Object.assign(ctx, {
      agentId: agent.id,
      agentName: agent.name,
    });
  }
  next();
}

/**
 * Middleware to set issue context in log context.
 */
export function issueContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  const issueId = req.params.issueId;
  const issueIdentifier = req.params.identifier;
  if (issueId || issueIdentifier) {
    const ctx = getContext();
    Object.assign(ctx, {
      issueId,
      issueIdentifier,
    });
  }
  next();
}
