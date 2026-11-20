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

`bun run build` writes a `.tar.zst` development archive under `dist/` with a synthetic source identity. GitHub CI builds the same package on both Linux architectures and attaches development archives with the tested repository ID and commit.

## Adapt the app

- Change the namespaced app ID, version, display metadata and requested permissions in `app.config.json`.
- Define app operations and their permissions in `api/openapi.json`. The example separates `greeting-read` and `greeting-write`.
- Implement operations in `src/server/` and the static React UI in `src/features/Greeting/`. The UI requests operations through the typed MessageChannel bridge.

Platform passes the bootstrap descriptor on stdin and authorizes access to the private `app.sock` and `core.sock` sockets. The backend verifies its own installation context with `GET /platform/v1/context` before it announces readiness. The app stores its data in its private working directory.

## Package and submit

The build produces `bin/app`, a generated `app.json` with target and source identity, `api/openapi.json`, `ui/` assets, and `LICENSE`. The [Marketplace candidate build](https://github.com/RentnerProxy/marketplace/issues/4) uses the same `bun run build` entrypoint and supplies `APP_PACKAGE_DIR`, `APP_TARGET`, `APP_SOURCE_REPOSITORY_ID` and `APP_SOURCE_COMMIT`.

Push the intended revision to a public GitHub repository. Submit its `owner/repo` and the full commit SHA from `git rev-parse HEAD`, along with the app ID, version, and targets. Marketplace builds the submitted source in isolation. Its approval and signed catalog workflow uses the exact approved package digests. [Version submissions](https://github.com/RentnerProxy/marketplace/issues/26) · [Signed catalog](https://github.com/RentnerProxy/marketplace/issues/5)
