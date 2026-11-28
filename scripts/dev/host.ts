import { join } from 'node:path'

import { isRecord, isRecordId, readGreeting } from '../../src/lib/greeting.ts'

import { startDevRuntime } from './runtime.ts'

interface DevHostOptions {
    uiDirectory: string
    executable?: string
    dataDirectory: string
    databaseAdminUrl?: string
    port?: number
}

const assetPrefix = '/__app-ui/greeting-fixture/'
const assets = new Map([
    ['index.html', { mime: 'text/html; charset=utf-8', destination: 'iframe' }],
    ['app.js', { mime: 'text/javascript; charset=utf-8', destination: 'script' }],
    ['app.css', { mime: 'text/css; charset=utf-8', destination: 'style' }],
])
const securityHeaders = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
}
const hostPolicy = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "frame-src 'self'",
    "connect-src 'self'",
].join('; ')

function hostDocument(installationId: string, generation: number) {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Greeting app development</title>
    <script defer src="/host.js"></script>
</head>
<body data-installation-id="${installationId}" data-installation-generation="${generation}">
    <h1>Greeting app development</h1>
    <p>Local Platform stub</p>
    <label>Theme <select id="theme"><option value="light">Light</option><option value="dark">Dark</option></select></label>
    <label>Language <select id="locale"><option value="en">English</option><option value="de">Deutsch</option></select></label>
    <label>Route <select id="route"><option value="overview">Overview</option><option value="details">Details</option></select></label>
    <label><input id="app-ready" type="checkbox" checked> App ready</label>
    <button id="replace-frame" type="button">Replace app</button>
    <div id="frame-slot"></div>
    <dialog aria-label="Confirm greeting">
        <p>Save this greeting?</p>
        <button id="confirm-save" type="button">Confirm</button>
        <button id="cancel-save" type="button">Cancel</button>
    </dialog>
</body>
</html>`
}

function assetResponse(request: Request, pathname: string, origin: string, uiDirectory: string) {
    if (!pathname.startsWith(assetPrefix)) return new Response(null, { status: 404 })
    const filename = pathname.slice(assetPrefix.length)
    const asset = assets.get(filename)
    if (!asset) return new Response(null, { status: 404 })
    const document = filename === 'index.html'
    const destination = request.headers.get('Sec-Fetch-Dest')
    const mode = request.headers.get('Sec-Fetch-Mode')
    const requestOrigin = request.headers.get('Origin')
    const allowed = document
        ? mode === 'navigate' && request.headers.get('Sec-Fetch-Site') === 'same-origin'
        : (mode === 'no-cors' || mode === 'cors') &&
          (requestOrigin === null || requestOrigin === 'null')
    if (destination !== asset.destination || !allowed) return new Response(null, { status: 403 })
    const source = origin + assetPrefix
    return new Response(Bun.file(join(uiDirectory, filename)), {
        headers: {
            ...securityHeaders,
            'Content-Type': asset.mime,
            'Content-Security-Policy': [
                "default-src 'none'",
                "base-uri 'none'",
                "form-action 'none'",
                'frame-ancestors ' + origin,
                'script-src ' + source,
                'style-src ' + source,
                'sandbox allow-scripts',
            ].join('; '),
            ...(!document && { 'Access-Control-Allow-Origin': 'null' }),
        },
    })
}

/** Serve built UI and a bootstrapped app on loopback for local development and browser smoke tests. */
export async function startDevHost({
    uiDirectory,
    executable,
    dataDirectory,
    databaseAdminUrl,
    port = 0,
}: DevHostOptions) {
    for (const filename of assets.keys()) {
        if (!(await Bun.file(join(uiDirectory, filename)).exists())) {
            throw new Error('Missing built UI asset: ' + filename)
        }
    }
    const build = await Bun.build({
        entrypoints: [join(import.meta.dir, 'browser.ts')],
        target: 'browser',
        define: { GREETING_ASSET_PREFIX: JSON.stringify(assetPrefix) },
    })
    const [browserScript] = build.outputs
    if (!build.success || !browserScript) throw new Error('Could not build the local Platform host')

    const runtime = await startDevRuntime({
        dataDirectory,
        ...(executable && { executable }),
        ...(databaseAdminUrl && { databaseAdminUrl }),
    })

    try {
        const server = Bun.serve({
            hostname: '127.0.0.1',
            port,
            development: false,
            maxRequestBodySize: 4096,
            async fetch(request, listener) {
                const { host, origin } = listener.url
                if (request.headers.get('Host') !== host) return new Response(null, { status: 403 })
                const { pathname, search } = new URL(request.url)
                if (search) return new Response(null, { status: 404 })
                if (pathname === '/dev/v1/greeting') {
                    if (
                        request.method !== 'POST' ||
                        request.headers.get('Origin') !== origin ||
                        request.headers.get('Sec-Fetch-Site') !== 'same-origin' ||
                        request.headers.get('Content-Type') !== 'application/json'
                    ) {
                        return new Response(null, { status: 403 })
                    }
                    const value: unknown = await request.json().catch(() => null)
                    if (!isRecord(value) || !isRecordId(value.idempotencyKey)) {
                        return new Response(null, { status: 400 })
                    }
                    const { operationId, payload, idempotencyKey } = value
                    if (
                        operationId === 'get-greeting' &&
                        isRecord(payload) &&
                        !Object.keys(payload).length
                    ) {
                        return await call(operationId, {}, idempotencyKey)
                    }
                    const greeting = readGreeting(payload)
                    if (operationId === 'save-greeting' && greeting !== undefined) {
                        return await call(operationId, { greeting }, idempotencyKey)
                    }
                    return new Response(null, { status: 400 })
                }
                if (request.method !== 'GET') return new Response(null, { status: 404 })
                if (pathname === '/') {
                    return new Response(hostDocument(runtime.installationId, runtime.generation), {
                        headers: {
                            ...securityHeaders,
                            'Content-Security-Policy': hostPolicy,
                            'Content-Type': 'text/html; charset=utf-8',
                        },
                    })
                }
                if (pathname === '/host.js') {
                    return new Response(browserScript, {
                        headers: {
                            ...securityHeaders,
                            'Content-Type': 'text/javascript; charset=utf-8',
                            'Cross-Origin-Resource-Policy': 'same-origin',
                        },
                    })
                }
                return assetResponse(request, pathname, origin, uiDirectory)
            },
        })

        let stopping: Promise<void> | undefined
        function stop() {
            stopping ??= (async () => {
                try {
                    await server.stop(true)
                } finally {
                    await runtime.stop()
                }
            })()
            return stopping
        }
        return { url: server.url, exited: runtime.exited, stop }
    } catch (error) {
        await runtime.stop()
        throw error
    }

    async function call(
        operation: 'get-greeting' | 'save-greeting',
        payload: Record<string, string>,
        idempotencyKey: string,
    ) {
        try {
            const result = await runtime.callGreeting(operation, payload, idempotencyKey)
            const greeting = result.ok ? readGreeting(await result.json()) : undefined
            if (greeting !== undefined)
                return Response.json({ greeting }, { headers: securityHeaders })
        } catch {
            // The local host does not expose the app socket or its errors to the browser.
        }
        return new Response(null, { status: 502 })
    }
}
