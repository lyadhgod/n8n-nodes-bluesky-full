# Contributing to n8n-nodes-bluesky-full

Thanks for taking the time to contribute! This document covers how to set up
a development environment and the branching/release rules for this repo.

## Branching model

- `main` is the release branch. It **never receives pull requests directly**.
- `dev` is the integration branch for all development work. All feature
  branches and pull requests should target `dev`, not `main`.
- Once changes on `dev` are ready for release, they are merged into `main`,
  where the release/publish process is run (see [Releasing](#releasing)
  below).

In short: **feature branch → `dev` → `main` → published.**

## Development environment

Before you start, make sure you have the following set up:

- **Node.js 22**
- **`only-allow`** installed globally (`npm i -g only-allow`) — enforces the
  correct package manager for this repo.
- **`@n8n/node-cli`** installed globally (`npm i -g @n8n/node-cli`) — provides
  the `n8n-node` CLI used for dev, build, lint, and release.
- **`n8n`** installed globally (`npm i -g n8n`) — used to run a local n8n
  instance against your node during development.
- **`mitmproxy`** and **`lsof`** installed (`apt-get install mitmproxy lsof`
  on Debian/Ubuntu) — used to inspect the HTTP traffic your node produces
  against the target API while developing.

Also export these environment variables in your shell profile for the local
n8n instance:

```sh
export N8N_LOG_LEVEL=debug
export N8N_DEV_RELOAD=true
export N8N_RUNNERS_ENABLED=false
export N8N_USER_FOLDER=~/.n8n-node-cli
export N8N_DIAGNOSTICS_ENABLED=false
export N8N_VERSION_NOTIFICATIONS_ENABLED=false
```

### Running the dev stack

Development requires three long-running processes, each in its own terminal,
started **in this order**:

1. **`npm run dev`**
   Runs `n8n-node dev --external-n8n`, which builds the node in watch mode
   and links it so an externally-running n8n instance can pick up changes
   live.

2. **`npm run dev:proxy`**
   Runs `mitmproxy --listen-port 9090`. This starts a local proxy on port
   9090 that sits between n8n and the external API, so you can inspect
   (and replay) the requests/responses your node makes while developing.

3. **`npm run dev:n8n`**
   Starts a local n8n instance on port 5678, configured to route all HTTP/S
   traffic through the `dev:proxy` mitmproxy instance (`NODE_EXTRA_CA_CERTS`,
   `HTTP_PROXY`, `HTTPS_PROXY`) so requests appear in mitmproxy.

Once all three are running, open n8n at `http://localhost:5678` — your node
will be available and will hot-reload as you make changes, and you can watch
its live traffic in the mitmproxy terminal UI.

## Linting and type-checking

Always fix lint/type errors before opening a PR, unless there's a specific,
documented reason to suppress one:

```sh
npm run lint
npm run lint:fix
```

## Tests

```sh
npm test
```

## Releasing

Releases are only cut from `main`, after `dev` has been merged in:

```sh
npm run release
```

This lints, builds, prompts for a version bump, updates `CHANGELOG.md`,
commits, tags, and pushes.
