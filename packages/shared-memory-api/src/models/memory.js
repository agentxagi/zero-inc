const { getDb } = require('./database');

const MAX_VALUE_SIZE = 10_240; // 10KB
const MAX_KEYS_PER_AGENT = 100;

function validateValueSize(value) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_VALUE_SIZE) {
    return `Value exceeds ${MAX_VALUE_SIZE} bytes limit (${bytes} bytes)`;
  }
  return null;
}

function validateKeyCount(db, agentId, companyId) {
  const count = db.prepare(
    'SELECT COUNT(*) as cnt FROM agent_memory WHERE agent_id = ? AND company_id = ?'
  ).get(agentId, companyId).cnt;
  if (count >= MAX_KEYS_PER_AGENT) {
    return `Agent has reached maximum of ${MAX_KEYS_PER_AGENT} keys`;
  }
  return null;
}

// --- Agent Memory ---

function setAgentMemory(agentId, companyId, key, value) {
  const db = getDb();
  const sizeError = validateValueSize(value);
  if (sizeError) return { error: sizeError, status: 413 };

  const existing = db.prepare(
    'SELECT id FROM agent_memory WHERE agent_id = ? AND company_id = ? AND key = ?'
  ).get(agentId, companyId, key);

  if (existing) {
    db.prepare(
      'UPDATE agent_memory SET value = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(value, existing.id);
  } else {
    const countError = validateKeyCount(db, agentId, companyId);
    if (countError) return { error: countError, status: 409 };
    db.prepare(
      'INSERT INTO agent_memory (agent_id, company_id, key, value) VALUES (?, ?, ?, ?)'
    ).run(agentId, companyId, key, value);
  }

  return { ok: true };
}

function getAgentMemory(agentId, companyId, key) {
  const db = getDb();
  if (key) {
    const row = db.prepare(
      'SELECT key, value, updated_at FROM agent_memory WHERE agent_id = ? AND company_id = ? AND key = ?'
    ).get(agentId, companyId, key);
    return row || null;
  }
  const rows = db.prepare(
    'SELECT key, value, updated_at FROM agent_memory WHERE agent_id = ? AND company_id = ? ORDER BY updated_at DESC'
  ).all(agentId, companyId);
  return rows;
}

function deleteAgentMemory(agentId, companyId, key) {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM agent_memory WHERE agent_id = ? AND company_id = ? AND key = ?'
  ).run(agentId, companyId, key);
  if (result.changes === 0) return { error: 'Key not found', status: 404 };
  return { ok: true, deleted: key };
}

// --- Shared Memory ---

function setSharedMemory(companyId, key, value, agentId) {
  const db = getDb();
  const sizeError = validateValueSize(value);
  if (sizeError) return { error: sizeError, status: 413 };

  const existing = db.prepare(
    'SELECT id FROM shared_memory WHERE company_id = ? AND key = ?'
  ).get(companyId, key);

  if (existing) {
    db.prepare(
      'UPDATE shared_memory SET value = ?, written_by_agent_id = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(value, agentId || null, existing.id);
  } else {
    db.prepare(
      'INSERT INTO shared_memory (company_id, key, value, written_by_agent_id) VALUES (?, ?, ?, ?)'
    ).run(companyId, key, value, agentId || null);
  }

  return { ok: true };
}

function getSharedMemory(companyId, key) {
  const db = getDb();
  if (key) {
    const row = db.prepare(
      'SELECT key, value, written_by_agent_id, updated_at FROM shared_memory WHERE company_id = ? AND key = ?'
    ).get(companyId, key);
    return row || null;
  }
  const rows = db.prepare(
    'SELECT key, value, written_by_agent_id, updated_at FROM shared_memory WHERE company_id = ? ORDER BY updated_at DESC'
  ).all(companyId);
  return rows;
}

// --- Heartbeat Context ---

function getHeartbeatMemory(agentId, companyId) {
  const db = getDb();
  const agentMem = db.prepare(
    'SELECT key, value FROM agent_memory WHERE agent_id = ? AND company_id = ?'
  ).all(agentId, companyId);
  const sharedMem = db.prepare(
    'SELECT key, value, written_by_agent_id FROM shared_memory WHERE company_id = ?'
  ).all(companyId);
  return { agentMemory: agentMem, sharedMemory: sharedMem };
}

module.exports = {
  setAgentMemory,
  getAgentMemory,
  deleteAgentMemory,
  setSharedMemory,
  getSharedMemory,
  getHeartbeatMemory,
};
