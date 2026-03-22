const express = require('express');
const memory = require('../models/memory');

const router = express.Router();

// GET /api/agents/:agentId/heartbeat-memory?companyId=xxx
// Returns agent memory + all company shared memory for heartbeat injection
router.get('/:agentId/heartbeat-memory', (req, res) => {
  const companyId = req.query.companyId || req.companyId;
  if (!companyId) return res.status(400).json({ error: 'Missing companyId' });

  // In dev mode, allow direct access; in prod, require matching agentId
  if (process.env.NODE_ENV !== 'development' && req.agentId !== req.params.agentId) {
    return res.status(403).json({ error: 'Can only access your own heartbeat memory' });
  }

  const result = memory.getHeartbeatMemory(req.params.agentId, companyId);
  res.json(result);
});

module.exports = router;
