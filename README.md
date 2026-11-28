# RentnerProxy app template

Use this template or fork it to start a RentnerProxy app. Greeting is a small Bun backend with a packaged React UI. It saves one greeting per installation, follows the host theme and language, and asks the host to confirm a change.

## Run locally

Use AMD64 or ARM64 Linux, Bun **1.4.4**, GNU tar and `zstd`.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run dev
bun run check
bun run test
bun run build
```

Open the loopback URL printed by `bun run dev`. The local Platform stub starts the real backend with synthetic installation data and hosts the UI in an isolated iframe. Use the controls to switch theme, language or route, simulate readiness changes, or replace the iframe. The greeting survives a restart in `.app-dev/data`.

The stub also serves the `core.sock` platform API from the published contract: context, authorization checks, notifications, audit events, owned proxy host changes as durable operations, and the event stream. Operations it does not simulate answer `501 notImplemented`. To give the app a database, set `APP_DEV_DATABASE_URL` to the superuser URL of a disposable PostgreSQL 18. The stub then provisions the database and runs the migrations like the platform. `bun run test` runs the database test when `APP_TEST_DATABASE_URL` points to such a server.

`bun run build` writes a `.tar.zst` development archive under `dist/` with a synthetic source identity. GitHub CI builds the same package on both Linux architectures and attaches development archives with the tested repository ID and commit.

## Adapt the app

- Change the namespaced app ID, version, display metadata and requested permissions in `app.config.json`. The build validates it against [`@rentnerproxy/app-contracts`](https://www.npmjs.com/package/@rentnerproxy/app-contracts).
- Define app operations and their permissions in `api/openapi.json`. The example separates `greeting-read` and `greeting-write`. This document describes only the app's own operations; the platform protocol comes from the contract package. Its `x-rentnerproxy-native-ui` block lets the platform render the overview form and details table natively.
- Implement operations in `src/server/` and the static React UI in `src/features/Greeting/`. The UI requests operations through the typed MessageChannel bridge.

Platform passes the bootstrap descriptor on stdin and authorizes access to the private `app.sock` and `core.sock` sockets. The backend verifies its own installation context with `GET /platform/v1/context` before it announces readiness. Greeting stores its greeting in its private working directory.

`src/server/platform-client.ts` calls `core.sock` through the contract's typed request and response descriptors. Give every change an idempotency key from `newIdempotencyKey()` and reuse it for retries, also after a restart; the client repeats such calls itself when the platform is briefly unavailable. `waitForOperation()` polls durable operations, and `followPlatformEvents()` resumes the event stream from the last processed cursor and calls your resynchronization when the cursor expired (410). A `PlatformApiError` with `staleGeneration` (412, or a rejected credential or generation) means a newer generation replaced this process: stop background work instead of retrying.

## Data and migrations

The platform provisions a PostgreSQL database for apps that declare `data`. It runs the declared `migrations/**.sql` steps in one transaction as a separate schema owner and records the reached version. Steps must be plain SQL without transaction control or psql commands. Version 0 means a new installation; each step leads from `fromVersion` to the target. The example targets version 2 from both 0 and 1, because Greeting 1.0 kept version 1 in files only. Bump `targetVersion`, `readVersions` and `writeVersions` together and add a step for every version that installations may have.

At runtime, `openAppDatabase()` in `src/server/database.ts` connects with Bun's SQL client as the runtime role from `RENTNERPROXY_APP_DATABASE_URL_FILE`. That role may only read and change rows in the `app` schema, such as the example table `app.greeting_history`.

## Package and submit

The build produces `bin/app`, a generated `app.json` with target and source identity, `api/openapi.json`, `ui/` assets, `migrations/`, and `LICENSE`. The [Marketplace candidate build](https://github.com/RentnerProxy/marketplace/issues/4) uses the same `bun run build` entrypoint and supplies `APP_PACKAGE_DIR`, `APP_TARGET`, `APP_SOURCE_REPOSITORY_ID` and `APP_SOURCE_COMMIT`.

Push the intended revision to a public GitHub repository. Submit its `owner/repo` and the full commit SHA from `git rev-parse HEAD`, along with the app ID, version, and targets. Marketplace builds the submitted source in isolation. Its approval and signed catalog workflow uses the exact approved package digests. [Version submissions](https://github.com/RentnerProxy/marketplace/issues/26) · [Signed catalog](https://github.com/RentnerProxy/marketplace/issues/5)
