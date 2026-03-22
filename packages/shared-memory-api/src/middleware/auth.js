/**
 * Authentication middleware — validates Bearer token via ZeroInc API.
 * Falls back to trusting X-Agent-Id / X-Company-Id headers in dev mode.
 */

const ZEROINC_API_URL = process.env.PAPERCLIP_API_URL;

async function validateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Dev mode: accept direct headers
    if (process.env.NODE_ENV === 'development' && req.headers['x-agent-id'] && req.headers['x-company-id']) {
      req.agentId = req.headers['x-agent-id'];
      req.companyId = req.headers['x-company-id'];
      return next();
    }
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);

  try {
    const resp = await fetch(`${ZEROINC_API_URL}/api/agents/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return res.status(401).json({ error: 'Invalid token' });
    const agent = await resp.json();
    req.agentId = agent.id;
    req.companyId = agent.companyId;
    req.agentRole = agent.role;
  } catch {
    return res.status(502).json({ error: 'Unable to validate token with ZeroInc' });
  }

  next();
}

function requireAgentAccess(req, res, next) {
  // Only allow an agent to access its own memory
  const targetAgentId = req.params.agentId;
  if (req.agentId !== targetAgentId && req.agentRole !== 'ceo' && req.agentRole !== 'cto') {
    return res.status(403).json({ error: 'Can only access your own memory' });
  }
  next();
}

module.exports = { validateToken, requireAgentAccess };
