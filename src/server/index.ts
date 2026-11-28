import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'

import { defaultGreeting, isRecord, isRecordId, readGreeting } from '@/lib/greeting.ts'

import appConfig from '../../app.config.json'
import { protocolVersion, readBootstrap } from './bootstrap.ts'
import { hasJsonContentType, maxJsonSize, readJson } from './json.ts'
import { createPlatformClient } from './platform-client.ts'
import { verifyPlatformContextService } from './platform-context.ts'

const statePath = 'greeting.json'

async function loadGreetingService(): Promise<string> {
    try {
        const greeting = readGreeting(await readJson(Bun.file(statePath).stream()))
        if (greeting === undefined) throw new Error('Invalid greeting state')
        return greeting
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return defaultGreeting
        }
        throw error
    }
}

async function saveGreetingService(greeting: string): Promise<void> {
    const temporaryPath = `${statePath}.${randomUUID()}.tmp`
    try {
        await writeFile(temporaryPath, `${JSON.stringify({ greeting })}\n`, {
            flag: 'wx',
            mode: 0o600,
            flush: true,
        })
        await rename(temporaryPath, statePath)
    } finally {
        await rm(temporaryPath, { force: true })
    }
}

function problem(status: number, code: string, title: string): Response {
    return Response.json(
        { type: `urn:rentnerproxy:problem:${code}`, code, status, title, requestId: randomUUID() },
        {
            status,
            headers: { 'Content-Type': 'application/problem+json' },
        },
    )
}

function methodNotAllowed(method: string): Response {
    return new Response(null, { status: 405, headers: { Allow: method } })
}

async function start(): Promise<void> {
    const bootstrap = await readBootstrap()
    await verifyPlatformContextService(createPlatformClient(bootstrap), bootstrap)
    const { appSocket, appAuthorization, installationId } = bootstrap
    const generation = String(bootstrap.generation)
    let greeting = await loadGreetingService()
    let pendingWrite = Promise.resolve()

    const previousMask = process.umask(0o117)
    try {
        const server = Bun.serve({
            unix: appSocket,
            development: false,
            maxRequestBodySize: maxJsonSize,
            async fetch(request) {
                const authorization = Buffer.from(request.headers.get('Authorization') ?? '')
                if (
                    authorization.length !== appAuthorization.length ||
                    !timingSafeEqual(authorization, appAuthorization) ||
                    request.headers.get('X-App-Installation') !== installationId ||
                    request.headers.get('X-App-Generation') !== generation
                ) {
                    return problem(403, 'scopeDenied', 'Installation context rejected')
                }
                const url = new URL(request.url)
                if (url.search) return problem(404, 'notFound', 'Operation not found')
                if (url.pathname === '/app/v1/health' || url.pathname === '/app/v1/ready') {
                    if (request.method !== 'GET') return methodNotAllowed('GET')
                    return url.pathname === '/app/v1/health'
                        ? Response.json({ healthy: true })
                        : Response.json({
                              ready: true,
                              protocolVersion,
                              dataVersion: appConfig.data.targetVersion,
                              providers: [],
                          })
                }
                const reading = url.pathname === '/app/v1/api/get-greeting'
                if (!reading && url.pathname !== '/app/v1/api/save-greeting') {
                    return problem(404, 'notFound', 'Operation not found')
                }
                if (request.method !== 'POST') return methodNotAllowed('POST')
                if (!isRecordId(request.headers.get('Idempotency-Key'))) {
                    return problem(400, 'invalidRequest', 'Invalid idempotency key')
                }
                if (!request.body || !hasJsonContentType(request.headers)) {
                    return problem(415, 'invalidRequest', 'Expected a JSON request')
                }
                const input = await readJson(request.body).catch(() => undefined)
                if (reading) {
                    if (!isRecord(input) || Object.keys(input).length !== 0) {
                        return problem(400, 'invalidRequest', 'Expected an empty object')
                    }
                    await pendingWrite
                    return Response.json({ greeting })
                }
                const next = readGreeting(input)
                if (next === undefined) return problem(400, 'invalidRequest', 'Invalid greeting')
                const write = pendingWrite.then(async () => {
                    if (next === greeting) return
                    await saveGreetingService(next)
                    greeting = next
                })
                pendingWrite = write.catch(() => undefined)
                await write
                return Response.json({ greeting: next })
            },
            error() {
                return problem(500, 'internalError', 'Greeting operation failed')
            },
        })
        try {
            chmodSync(appSocket, 0o660)
        } catch (error) {
            await server.stop(true)
            throw error
        }
    } finally {
        process.umask(previousMask)
    }
}

await start().catch(() => process.exit(1))
