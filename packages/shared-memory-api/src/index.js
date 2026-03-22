const express = require('express');
const { validateToken } = require('./middleware/auth');
const agentMemoryRoutes = require('./routes/agentMemory');
const sharedMemoryRoutes = require('./routes/sharedMemory');
const heartbeatMemoryRoutes = require('./routes/heartbeatMemory');
const boardRoutes = require('./routes/board');

const app = express();
app.use(express.json({ limit: '12kb' }));

// Health check (no auth)
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'shared-memory-api' }));

// Board UI (no auth — has its own token handling)
app.use(boardRoutes);

// All /api routes require auth
app.use('/api', validateToken);

app.use('/api/agents', agentMemoryRoutes);
app.use('/api/companies', sharedMemoryRoutes);
app.use('/api/agents', heartbeatMemoryRoutes);

const PORT = process.env.MEMORY_API_PORT || 3090;
app.listen(PORT, () => {
  console.log(`Shared Memory API listening on port ${PORT}`);
});

module.exports = app;
