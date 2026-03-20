---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `zeroinc run`

One-command bootstrap and start:

```sh
pnpm zeroinc run
```

Does:

1. Auto-onboards if config is missing
2. Runs `zeroinc doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm zeroinc run --instance dev
```

## `zeroinc onboard`

Interactive first-time setup:

```sh
pnpm zeroinc onboard
```

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm zeroinc onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm zeroinc onboard --yes
```

## `zeroinc doctor`

Health checks with optional auto-repair:

```sh
pnpm zeroinc doctor
pnpm zeroinc doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration
- Storage configuration
- Missing key files

## `zeroinc configure`

Update configuration sections:

```sh
pnpm zeroinc configure --section server
pnpm zeroinc configure --section secrets
pnpm zeroinc configure --section storage
```

## `zeroinc env`

Show resolved environment configuration:

```sh
pnpm zeroinc env
```

## `zeroinc allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm zeroinc allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.zeroinc/instances/default/config.json` |
| Database | `~/.zeroinc/instances/default/db` |
| Logs | `~/.zeroinc/instances/default/logs` |
| Storage | `~/.zeroinc/instances/default/data/storage` |
| Secrets key | `~/.zeroinc/instances/default/secrets/master.key` |

Override with:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm zeroinc run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm zeroinc run --data-dir ./tmp/zeroinc-dev
pnpm zeroinc doctor --data-dir ./tmp/zeroinc-dev
```
