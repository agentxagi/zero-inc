const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp DB for tests
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
process.env.MEMORY_DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.NODE_ENV = 'development';

// Clear cached DB before loading
delete require.cache[require.resolve('../models/database')];
delete require.cache[require.resolve('../models/memory')];

const memory = require('../models/memory');

const AGENT = 'agent-001';
const COMPANY = 'company-001';

describe('Agent Memory', () => {
  beforeEach(() => {
    const { getDb } = require('../models/database');
    const db = getDb();
    db.exec('DELETE FROM agent_memory');
    db.exec('DELETE FROM shared_memory');
  });

  it('sets and gets a single key', () => {
    memory.setAgentMemory(AGENT, COMPANY, 'last_check', '2026-03-22T10:00:00Z');
    const result = memory.getAgentMemory(AGENT, COMPANY, 'last_check');
    assert.equal(result.key, 'last_check');
    assert.equal(result.value, '2026-03-22T10:00:00Z');
  });

  it('updates an existing key (upsert)', () => {
    memory.setAgentMemory(AGENT, COMPANY, 'focus', 'task-A');
    memory.setAgentMemory(AGENT, COMPANY, 'focus', 'task-B');
    const result = memory.getAgentMemory(AGENT, COMPANY, 'focus');
    assert.equal(result.value, 'task-B');
  });

  it('lists all keys', () => {
    memory.setAgentMemory(AGENT, COMPANY, 'a', '1');
    memory.setAgentMemory(AGENT, COMPANY, 'b', '2');
    const all = memory.getAgentMemory(AGENT, COMPANY);
    assert.equal(all.length, 2);
  });

  it('deletes a key', () => {
    memory.setAgentMemory(AGENT, COMPANY, 'tmp', 'value');
    const result = memory.deleteAgentMemory(AGENT, COMPANY, 'tmp');
    assert.equal(result.ok, true);
    assert.equal(memory.getAgentMemory(AGENT, COMPANY, 'tmp'), null);
  });

  it('returns 404 when deleting non-existent key', () => {
    const result = memory.deleteAgentMemory(AGENT, COMPANY, 'nope');
    assert.equal(result.error, 'Key not found');
    assert.equal(result.status, 404);
  });

  it('rejects values over 10KB', () => {
    const big = 'x'.repeat(10241);
    const result = memory.setAgentMemory(AGENT, COMPANY, 'big', big);
    assert.equal(result.error.includes('exceeds'), true);
    assert.equal(result.status, 413);
  });

  it('enforces 100 key limit', () => {
    for (let i = 0; i < 100; i++) {
      memory.setAgentMemory(AGENT, COMPANY, `key-${i}`, `val-${i}`);
    }
    const result = memory.setAgentMemory(AGENT, COMPANY, 'key-100', 'overflow');
    assert.equal(result.error.includes('maximum'), true);
    assert.equal(result.status, 409);
  });

  it('isolates memory per agent', () => {
    memory.setAgentMemory(AGENT, COMPANY, 'secret', 'agent-data');
    const other = memory.getAgentMemory('agent-002', COMPANY, 'secret');
    assert.equal(other, null);
  });

  it('isolates memory per company', () => {
    memory.setAgentMemory(AGENT, COMPANY, 'secret', 'company-a-data');
    const other = memory.getAgentMemory(AGENT, 'company-002', 'secret');
    assert.equal(other, null);
  });
});

describe('Shared Memory', () => {
  beforeEach(() => {
    const { getDb } = require('../models/database');
    const db = getDb();
    db.exec('DELETE FROM agent_memory');
    db.exec('DELETE FROM shared_memory');
  });

  it('sets and gets shared key', () => {
    memory.setSharedMemory(COMPANY, 'system_health', 'all systems nominal', AGENT);
    const result = memory.getSharedMemory(COMPANY, 'system_health');
    assert.equal(result.key, 'system_health');
    assert.equal(result.value, 'all systems nominal');
    assert.equal(result.written_by_agent_id, AGENT);
  });

  it('last write wins on shared memory', () => {
    memory.setSharedMemory(COMPANY, 'status', 'v1', 'agent-001');
    memory.setSharedMemory(COMPANY, 'status', 'v2', 'agent-002');
    const result = memory.getSharedMemory(COMPANY, 'status');
    assert.equal(result.value, 'v2');
    assert.equal(result.written_by_agent_id, 'agent-002');
  });

  it('lists all shared keys', () => {
    memory.setSharedMemory(COMPANY, 'a', '1');
    memory.setSharedMemory(COMPANY, 'b', '2');
    const all = memory.getSharedMemory(COMPANY);
    assert.equal(all.length, 2);
  });

  it('rejects values over 10KB', () => {
    const big = 'x'.repeat(10241);
    const result = memory.setSharedMemory(COMPANY, 'big', big);
    assert.equal(result.status, 413);
  });
});

describe('Heartbeat Memory', () => {
  beforeEach(() => {
    const { getDb } = require('../models/database');
    const db = getDb();
    db.exec('DELETE FROM agent_memory');
    db.exec('DELETE FROM shared_memory');
  });

  it('returns both agent and shared memory', () => {
    memory.setAgentMemory(AGENT, COMPANY, 'focus', 'task-A');
    memory.setSharedMemory(COMPANY, 'infra', 'healthy', 'sre-agent');

    const result = memory.getHeartbeatMemory(AGENT, COMPANY);
    assert.equal(result.agentMemory.length, 1);
    assert.equal(result.sharedMemory.length, 1);
    assert.equal(result.agentMemory[0].key, 'focus');
    assert.equal(result.sharedMemory[0].key, 'infra');
  });

  it('returns empty arrays when no memory exists', () => {
    const result = memory.getHeartbeatMemory('new-agent', 'new-company');
    assert.deepEqual(result.agentMemory, []);
    assert.deepEqual(result.sharedMemory, []);
  });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
