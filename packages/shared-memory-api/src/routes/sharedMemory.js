const express = require('express');
const memory = require('../models/memory');

const router = express.Router();

// POST /api/companies/:companyId/shared-memory — set a shared memory key
router.post('/:companyId/shared-memory', (req, res) => {
  const { key, value } = req.body;
  if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Missing or invalid "key"' });
  if (value === undefined || value === null) return res.status(400).json({ error: 'Missing "value"' });

  const result = memory.setSharedMemory(req.params.companyId, key, String(value), req.agentId || null);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, key, companyId: req.params.companyId });
});

// GET /api/companies/:companyId/shared-memory — get one or all shared keys
router.get('/:companyId/shared-memory', (req, res) => {
  const key = req.query.key || null;
  const result = memory.getSharedMemory(req.params.companyId, key);
  if (!key) return res.json({ keys: result, count: result.length });
  if (!result) return res.status(404).json({ error: 'Key not found' });
  res.json(result);
});

// GET /api/companies/:companyId/shared-memory/:key — get a specific key
router.get('/:companyId/shared-memory/:key', (req, res) => {
  const result = memory.getSharedMemory(req.params.companyId, req.params.key);
  if (!result) return res.status(404).json({ error: 'Key not found' });
  res.json(result);
});

module.exports = router;
