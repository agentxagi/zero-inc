const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-test-'));
process.env.MEMORY_DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.NODE_ENV = 'development';
process.env.MEMORY_API_PORT = '0'; // random port

// Clear caches
Object.keys(require.cache).forEach(k => {
  if (k.includes('shared-memory-api')) delete require.cache[k];
});

const app = require('../index');

const AGENT = 'agent-001';
const COMPANY = 'company-001';

const devHeaders = { 'X-Agent-Id': AGENT, 'X-Company-Id': COMPANY, 'Content-Type': 'application/json' };

function json(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = {
      method, url, headers: { ...devHeaders },
      body: body ? JSON.stringify(body) : undefined,
    };
    const res = {
      statusCode: 200,
      _data: '',
      setHeader() {},
      end(d) { this._data = d; resolve(this); },
      json(d) { this._data = JSON.stringify(d); this.setHeader('Content-Type', 'application/json'); this.end(this._data); },
      get statusCode() { return this._status || 200; },
      set statusCode(v) { this._status = v; },
    };
    app._router.handle(req, res, () => reject(new Error('no route')));
  });
}

// Simpler: use http server
const http = require('http');

let server, baseUrl;

before(async () => {
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function request(method, path, body) {
  const opts = {
    hostname: '127.0.0.1', port: server.address().port,
    path, method,
    headers: { ...devHeaders },
  };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { data = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('API - Health', () => {
  it('returns ok', async () => {
    const { status, body } = await request('GET', '/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  });
});

describe('API - Agent Memory', () => {
  it('requires auth', async () => {
    const opts = {
      hostname: '127.0.0.1', port: server.address().port,
      path: `/api/agents/${AGENT}/memory`, method: 'GET',
      headers: {},
    };
    const { status } = await new Promise((resolve, reject) => {
      const req = http.request(opts, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 401);
  });

  it('creates and retrieves agent memory', async () => {
    const r1 = await request('POST', `/api/agents/${AGENT}/memory`, { key: 'focus', value: 'task-A' });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.ok, true);

    const r2 = await request('GET', `/api/agents/${AGENT}/memory?key=focus`);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.key, 'focus');
    assert.equal(r2.body.value, 'task-A');
  });

  it('lists all agent memory', async () => {
    await request('POST', `/api/agents/${AGENT}/memory`, { key: 'a', value: '1' });
    await request('POST', `/api/agents/${AGENT}/memory`, { key: 'b', value: '2' });
    const r = await request('GET', `/api/agents/${AGENT}/memory`);
    assert.equal(r.status, 200);
    assert.ok(r.body.count >= 2);
  });

  it('deletes agent memory', async () => {
    await request('POST', `/api/agents/${AGENT}/memory`, { key: 'tmp', value: 'x' });
    const r = await request('DELETE', `/api/agents/${AGENT}/memory/tmp`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it('returns 404 for missing key', async () => {
    const r = await request('GET', `/api/agents/${AGENT}/memory/nonexistent`);
    assert.equal(r.status, 404);
  });

  it('rejects missing key', async () => {
    const r = await request('POST', `/api/agents/${AGENT}/memory`, { value: 'no-key' });
    assert.equal(r.status, 400);
  });
});

describe('API - Shared Memory', () => {
  it('creates and retrieves shared memory', async () => {
    const r1 = await request('POST', `/api/companies/${COMPANY}/shared-memory`, { key: 'health', value: 'ok' });
    assert.equal(r1.status, 200);

    const r2 = await request('GET', `/api/companies/${COMPANY}/shared-memory?key=health`);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.value, 'ok');
  });

  it('lists all shared memory', async () => {
    await request('POST', `/api/companies/${COMPANY}/shared-memory`, { key: 'x', value: '1' });
    const r = await request('GET', `/api/companies/${COMPANY}/shared-memory`);
    assert.ok(r.body.count >= 1);
  });
});

describe('API - Heartbeat Memory', () => {
  it('returns combined memory for heartbeat', async () => {
    await request('POST', `/api/agents/${AGENT}/memory`, { key: 'focus', value: 'task-A' });
    await request('POST', `/api/companies/${COMPANY}/shared-memory`, { key: 'infra', value: 'healthy' });

    const r = await request('GET', `/api/agents/${AGENT}/heartbeat-memory?companyId=${COMPANY}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.agentMemory.length >= 1);
    assert.ok(r.body.sharedMemory.length >= 1);
  });
});
