---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm zeroinc issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm zeroinc issue get <issue-id-or-identifier>

# Create issue
pnpm zeroinc issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm zeroinc issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm zeroinc issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm zeroinc issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm zeroinc issue release <issue-id>
```

## Company Commands

```sh
pnpm zeroinc company list
pnpm zeroinc company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm zeroinc company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm zeroinc company import \
  --from https://github.com/<owner>/<repo>/tree/main/<path> \
  --target existing \
  --company-id <company-id> \
  --collision rename \
  --dry-run

# Apply import
pnpm zeroinc company import \
  --from ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm zeroinc agent list
pnpm zeroinc agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm zeroinc approval list [--status pending]

# Get approval
pnpm zeroinc approval get <approval-id>

# Create approval
pnpm zeroinc approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm zeroinc approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm zeroinc approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm zeroinc approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm zeroinc approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm zeroinc approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm zeroinc activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm zeroinc dashboard get
```

## Heartbeat

```sh
pnpm zeroinc heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
