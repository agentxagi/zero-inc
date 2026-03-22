const express = require('express');
const memory = require('../models/memory');
const { requireAgentAccess } = require('../middleware/auth');

const router = express.Router();

// POST /api/agents/:agentId/memory — set a memory key
router.post('/:agentId/memory', requireAgentAccess, (req, res) => {
  const { key, value } = req.body;
  if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Missing or invalid "key"' });
  if (value === undefined || value === null) return res.status(400).json({ error: 'Missing "value"' });

  const result = memory.setAgentMemory(req.params.agentId, req.companyId, key, String(value));
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, key, agentId: req.params.agentId });
});

// GET /api/agents/:agentId/memory — get one or all memory keys
router.get('/:agentId/memory', requireAgentAccess, (req, res) => {
  const key = req.query.key || null;
  const result = memory.getAgentMemory(req.params.agentId, req.companyId, key);
  if (!key) return res.json({ keys: result, count: result.length });
  if (!result) return res.status(404).json({ error: 'Key not found' });
  res.json(result);
});

// GET /api/agents/:agentId/memory/:key — get a specific key
router.get('/:agentId/memory/:key', requireAgentAccess, (req, res) => {
  const result = memory.getAgentMemory(req.params.agentId, req.companyId, req.params.key);
  if (!result) return res.status(404).json({ error: 'Key not found' });
  res.json(result);
});

// DELETE /api/agents/:agentId/memory/:key — delete a key
router.delete('/:agentId/memory/:key', requireAgentAccess, (req, res) => {
  const result = memory.deleteAgentMemory(req.params.agentId, req.companyId, req.params.key);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

module.exports = router;
