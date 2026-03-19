---
title: Structured Logging
summary: JSON logging format and correlation IDs
---

Paperclip uses structured JSON logging with Pino for all server operations. Logs include correlation IDs for request tracing and context for agents, issues, and runs.

## Log Format

All logs are JSON objects with the following base structure:

```json
{
  "level": "info",
  "time": "2026-03-14T12:00:00.000Z",
  "msg": "Request completed",
  "service": "paperclip-api",
  "env": "production",
  "correlationId": "pc_m1abc123_def456"
}
```

### Standard Fields

| Field | Type | Description |
|-------|------|-------------|
| `level` | string | Log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `time` | string | ISO 8601 timestamp |
| `msg` | string | Human-readable message |
| `correlationId` | string | Unique ID for request tracing |

### Context Fields (when available)

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | string | Agent UUID |
| `agentName` | string | Agent display name |
| `issueId` | string | Issue UUID |
| `issueIdentifier` | string | Issue identifier (e.g., `VAL-29`) |
| `runId` | string | Heartbeat run UUID |
| `companyId` | string | Company UUID |
| `userId` | string | User UUID |

### HTTP Request Fields

| Field | Type | Description |
|-------|------|-------------|
| `req` | object | Request details (method, url, headers) |
| `res` | object | Response details (statusCode) |
| `responseTime` | number | Request duration in ms |
| `reqBody` | object | Request body (on errors only) |
| `reqParams` | object | Route parameters (on errors only) |
| `reqQuery` | object | Query parameters (on errors only) |

## Correlation IDs

Every HTTP request receives a correlation ID that is:

1. Propagated from `X-Correlation-Id` or `X-Request-Id` header if present
2. Auto-generated if not provided (`pc_<timestamp>_<random>`)
3. Returned in the response header `X-Correlation-Id`

### Usage in Code

```typescript
import { getContext, setContext, runWithContext } from "../logging/context.js";

// Get current context
const { correlationId, agentId } = getContext();

// Set context values
setContext({ agentId: "abc-123", agentName: "DevOps Engineer" });

// Run with isolated context
runWithContext({ correlationId: "custom-id" }, () => {
  // All logs in this scope have the correlationId
});
```

## Log Levels

Configure log level via environment variable:

```sh
# Development (default)
LOG_LEVEL=debug

# Production
LOG_LEVEL=info
```

## Log Output

Logs are written to two destinations:

1. **Console** (stdout): Pretty-printed, colorized output for `info` and above
2. **File**: JSON format to `~/.paperclip/instances/default/logs/server.log`

Configure log directory:

```sh
PAPERCLIP_LOG_DIR=/var/log/paperclip
```

## Integration with Log Aggregation

The JSON format is compatible with:

- **Elasticsearch/ELK**: Use Filebeat with `json.keys_under_root: true`
- **Datadog**: Logs are auto-parsed by Datadog agent
- **CloudWatch Logs**: JSON logs are searchable with CloudWatch Insights
- **Grafana Loki**: Use Promtail with JSON pipeline

### Example Filebeat Configuration

```yaml
filebeat.inputs:
  - type: log
    paths:
      - /var/log/paperclip/*.log
    json.keys_under_root: true
    json.add_error_key: true
    json.message_key: msg
```
