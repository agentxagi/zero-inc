import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";
import { createDb, type Db } from "@paperclipai/db";
import { createApp } from "../app.js";
import type { StorageService } from "../storage/types.js";

// Test configuration
const TEST_DB_PORT = 5433;

export interface TestContext {
  db: Db;
  app: express.Application;
  cleanup: () => Promise<void>;
  companyId: string;
  agentId: string;
  agentApiKey: string;
}

// Mock storage service for tests
function createMockStorageService(): StorageService {
  return {
    upload: async () => ({ id: randomUUID(), key: "test", contentType: "text/plain", size: 0, createdAt: new Date() }),
    download: async () => Buffer.from(""),
    delete: async () => {},
    getUrl: async () => "http://localhost/test",
  };
}

// Create a test database and app with a pre-seeded company and agent
export async function createTestContext(): Promise<TestContext> {
  // For integration tests, we'll use an in-memory approach with mocked database
  // This avoids needing a real PostgreSQL instance for basic API tests

  const app = express();
  app.use(express.json());

  // Mock database operations for integration tests
  const mockDb = createMockDb();

  // Create a test company and agent
  const companyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKey = `test-key-${randomUUID()}`;

  // Store test data
  mockDb._testData.companies.set(companyId, {
    id: companyId,
    name: "Test Company",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  mockDb._testData.agents.set(agentId, {
    id: agentId,
    companyId,
    name: "Test Agent",
    role: "engineer",
    title: "Test Engineer",
    icon: "code",
    status: "idle",
    adapterType: "process",
    adapterConfig: { command: "echo", args: ["hello"] },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Mock authentication middleware for tests
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Default to board actor, can be overridden per-test
    req.actor = { type: "board", userId: "test-user", source: "local_implicit" };
    next();
  });

  // Mount health route (simple, no DB needed)
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // Mount test routes
  app.get("/api/test/context", (_req: Request, res: Response) => {
    res.json({ companyId, agentId, agentApiKey });
  });

  const cleanup = async () => {
    // Cleanup any temp resources
  };

  return {
    db: mockDb as unknown as Db,
    app,
    cleanup,
    companyId,
    agentId,
    agentApiKey,
  };
}

// Simple mock database for testing
function createMockDb(): any {
  return {
    _testData: {
      companies: new Map(),
      agents: new Map(),
      issues: new Map(),
      heartbeatRuns: new Map(),
    },
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve([]),
    }),
  };
}

// Helper to create a test issue
export async function createTestIssue(
  ctx: TestContext,
  overrides: Partial<{
    id: string;
    title: string;
    status: string;
    priority: string;
    assigneeAgentId: string | null;
  }> = {}
): Promise<{ id: string; identifier: string }> {
  const id = overrides.id || randomUUID();
  const issueNumber = (ctx.db._testData.issues.size || 0) + 1;
  const identifier = `TEST-${issueNumber}`;

  const issue = {
    id,
    companyId: ctx.companyId,
    identifier,
    issueNumber,
    title: overrides.title || "Test Issue",
    description: "Test issue description",
    status: overrides.status || "todo",
    priority: overrides.priority || "medium",
    assigneeAgentId: overrides.assigneeAgentId ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  ctx.db._testData.issues.set(id, issue);
  return { id, identifier };
}

// Helper to make authenticated requests as an agent
export function agentRequest(ctx: TestContext, runId?: string) {
  const run = runId || randomUUID();
  return {
    setAuth: (req: request.Test) => {
      return req
        .set("Authorization", `Bearer ${ctx.agentApiKey}`)
        .set("X-Paperclip-Run-Id", run);
    },
    runId: run,
  };
}
