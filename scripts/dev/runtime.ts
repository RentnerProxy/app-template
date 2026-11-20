import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import appConfig from '../../app.config.json'
import { isRecord } from '../../src/lib/greeting.ts'

const timeoutMs = 5_000
const versions = { appProtocol: '1.0.0', platformApi: '1.0.0', uiBridge: '1.0.0' }

export type GreetingOperation = 'get-greeting' | 'save-greeting'

interface RuntimeOptions {
    dataDirectory: string
    executable?: string
    generation?: number
    launcher?: 'platform' | 'candidate'
    rejectContext?: boolean
}

interface Scope {
    generation?: number
    credential?: string
}

export async function startDevRuntime({
    dataDirectory,
    executable,
    generation = 1,
    launcher = 'platform',
    rejectContext = false,
}: RuntimeOptions) {
    if (process.platform !== 'linux') {
        throw new Error('The Greeting dev runtime uses Linux Unix sockets. Run it on Linux or WSL.')
    }
    const cwd = resolve(dataDirectory)
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    const socketDirectory = await mkdtemp('/tmp/rentnerproxy-greeting-')
    const coreSocket = join(socketDirectory, 'core.sock')
    const appSocket = join(socketDirectory, 'app.sock')
    const installationId = 'greeting-fixture'
    const binding = {
        appId: appConfig.id,
        installationId,
        generation,
        runtimeProfile: appConfig.requires.runtimeProfile,
        versions,
    }
    const encoding = launcher === 'candidate' ? 'hex' : 'base64url'
    const coreCredential = randomBytes(32).toString(encoding)
    const appCredential = randomBytes(32).toString(encoding)
    const coreAuthorization = Buffer.from('Bearer ' + coreCredential)
    let contextCalls = 0
    let core: ReturnType<typeof Bun.serve> | undefined
    let child: ReturnType<typeof Bun.spawn> | undefined
    let stopping: Promise<void> | undefined

    function headers(credential: string, scope?: Scope) {
        return {
            Authorization: 'Bearer ' + (scope?.credential ?? credential),
            'X-App-Installation': installationId,
            'X-App-Generation': String(scope?.generation ?? generation),
        }
    }

    function fetchCore(scope?: Scope) {
        return fetch('http://localhost/platform/v1/context', {
            unix: coreSocket,
            headers: headers(coreCredential, scope),
            signal: AbortSignal.timeout(timeoutMs),
        })
    }

    function fetchApp(path: 'health' | 'ready', scope?: Scope) {
        return fetch('http://localhost/app/v1/' + path, {
            unix: appSocket,
            headers: headers(appCredential, scope),
            signal: AbortSignal.timeout(timeoutMs),
        })
    }

    function callGreeting(
        operation: GreetingOperation,
        payload: Record<string, string>,
        idempotencyKey: string = randomUUID(),
        scope?: Scope,
    ) {
        return fetch('http://localhost/app/v1/api/' + operation, {
            unix: appSocket,
            method: 'POST',
            headers: {
                ...headers(appCredential, scope),
                'Content-Type': 'application/json',
                'Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
        })
    }

    function stop() {
        stopping ??= (async () => {
            try {
                if (child && child.exitCode === null && child.signalCode === null) {
                    const backend = child
                    backend.kill('SIGTERM')
                    const force = setTimeout(() => backend.kill('SIGKILL'), 500)
                    try {
                        await backend.exited
                    } finally {
                        clearTimeout(force)
                    }
                }
            } finally {
                try {
                    await core?.stop(true)
                } finally {
                    await rm(socketDirectory, { recursive: true, force: true })
                }
            }
        })()
        return stopping
    }

    try {
        core = Bun.serve({
            unix: coreSocket,
            development: false,
            maxRequestBodySize: 4096,
            fetch(request) {
                const { pathname, search } = new URL(request.url)
                if (pathname !== '/platform/v1/context' || search) {
                    return new Response(null, { status: 404 })
                }
                if (request.method !== 'GET') {
                    return new Response(null, { status: 405, headers: { Allow: 'GET' } })
                }
                const authorization = Buffer.from(request.headers.get('Authorization') ?? '')
                if (
                    authorization.length !== coreAuthorization.length ||
                    !timingSafeEqual(authorization, coreAuthorization) ||
                    request.headers.get('X-App-Installation') !== installationId ||
                    request.headers.get('X-App-Generation') !== String(generation) ||
                    rejectContext
                ) {
                    return Response.json({ error: 'installationContextRejected' }, { status: 403 })
                }
                contextCalls += 1
                return Response.json({ ...binding, capabilities: appConfig.capabilities })
            },
        })
        const descriptor = {
            formatVersion: 1,
            ...binding,
            appSocket,
            coreSocket,
            appCredential,
            coreCredential,
        }
        const command = executable
            ? [resolve(executable)]
            : [
                  process.execPath,
                  '--no-env-file',
                  join(import.meta.dir, '../../src/server/index.ts'),
              ]
        child = Bun.spawn({
            cmd:
                launcher === 'candidate'
                    ? [
                          '/bin/sh',
                          '-ceu',
                          'exec 3<&0 </dev/null; exec "$@" serve',
                          'app',
                          ...command,
                      ]
                    : command,
            cwd,
            env: launcher === 'platform' ? { RENTNERPROXY_APP_BOOTSTRAP_FD: '0' } : {},
            stdin: new Blob([JSON.stringify(descriptor)]),
            stdout: 'ignore',
            stderr: 'inherit',
        })
        const launched = child
        const deadline = performance.now() + timeoutMs
        while (performance.now() < deadline) {
            if (launched.exitCode !== null || launched.signalCode !== null) {
                throw new Error('Greeting app exited before readiness')
            }
            const readiness = await fetchApp('ready').catch(() => undefined)
            if (readiness?.ok) {
                const body: unknown = await readiness.json()
                if (
                    contextCalls === 1 &&
                    isRecord(body) &&
                    body.ready === true &&
                    body.protocolVersion === versions.appProtocol &&
                    body.dataVersion === appConfig.data.targetVersion
                ) {
                    return {
                        installationId,
                        generation,
                        contextCalls: () => contextCalls,
                        exited: launched.exited,
                        fetchApp,
                        fetchCore,
                        callGreeting,
                        stop,
                    }
                }
                throw new Error(
                    'Greeting app did not report readiness after a Platform context call',
                )
            }
            await Bun.sleep(20)
        }
        throw new Error('Timed out waiting for Greeting app readiness')
    } catch (error) {
        await stop()
        throw error
    }
}
