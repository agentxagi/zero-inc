# Plugin Authoring Smoke Example

A ZeroInc plugin

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

## Install Into ZeroInc

```bash
pnpm zeroinc plugin install ./
```

## Build Options

- `pnpm build` uses esbuild presets from `@zeroinc/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
