import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { ContractError, parseProtocolDocument, rpcLimits } from '@rentnerproxy/app-contracts'

import app from '../../app.config.json'
import { startDevCore } from '../../scripts/dev/core.ts'
import {
    createPlatformClient,
    followPlatformEvents,
    newIdempotencyKey,
    PlatformApiError,
    PlatformEventError,
    waitForOperation,
    type PlatformClient,
    type PlatformEvent,
} from '../server/platform-client.ts'

const linuxTest = test.skipIf(process.platform !== 'linux')
const installationId = 'greeting-fixture'
const grants = [
    { id: 'proxy.hosts.read.v1', scope: 'proxyHosts' },
    { id: 'proxy.hosts.manage-owned.v1', scope: 'ownedProxyHosts' },
    { id: 'notifications.publish.v1', scope: 'installation' },
]
const notification = {
    category: 'greeting',
    severity: 'info',
    title: 'Greeting saved',
    message: 'A new greeting is live.',
} as const
const upsert = {
    action: 'upsert',
    hostId: 'host-1',
    expectedRevision: null,
    hostname: 'app.example.net',
    upstream: { scheme: 'https', address: '192.0.2.1', port: 8443 },
} as const

interface Platform {
    core: ReturnType<typeof startDevCore>
    client: PlatformClient
    connect: (scope: { generation?: number; credential?: string }) => PlatformClient
}

async function withPlatform(run: (platform: Platform) => Promise<void>, capabilities = grants) {
    const directory = await mkdtemp('/tmp/rentnerproxy-client-')
    const socket = join(directory, 'core.sock')
    const credential = randomBytes(32).toString('base64url')
    const context = parseProtocolDocument('PlatformContext', {
        appId: app.id,
        installationId,
        generation: 1,
        runtimeProfile: app.requires.runtimeProfile,
        versions: { appProtocol: '1.0.0', platformApi: '1.0.0', uiBridge: '1.0.0' },
        capabilities,
    })
    const core = startDevCore({ socket, credential, context })
    const connect: Platform['connect'] = (scope) =>
        createPlatformClient({
            coreSocket: socket,
            coreAuthorization: 'Bearer ' + (scope.credential ?? credential),
            installationId,
            generation: scope.generation ?? 1,
        })
    try {
        await run({ core, client: connect({}), connect })
    } finally {
        await core.stop()
        await rm(directory, { recursive: true, force: true })
    }
}

/** Resolve with the platform problem that a call rejects with. */
async function problemOf(call: Promise<unknown>) {
    const error = await call.then(
        () => undefined,
        (rejection: unknown) => rejection,
    )
    if (!(error instanceof PlatformApiError)) throw new Error('Expected a platform problem')
    return error
}

async function firstEvent(events: AsyncGenerator<PlatformEvent>) {
    for await (const event of events) return event
    throw new Error('The event stream closed without an event')
}

linuxTest('Platform calls are typed and validated by the published contract', () =>
    withPlatform(async ({ client }) => {
        expect(await client.call('getPlatformContext')).toMatchObject({
            installationId,
            generation: 1,
        })
        const capability = { id: 'proxy.hosts.read.v1', scope: 'proxyHosts' } as const
        const check = { body: { capability, resourceId: 'host-1' } }
        expect(await client.call('checkAuthorization', check)).toStrictEqual({ allowed: true })
        const invalid = { body: { resourceId: 'host-1' } as never }
        await expect(client.call('checkAuthorization', invalid)).rejects.toBeInstanceOf(
            ContractError,
        )
    }),
)

linuxTest('A repeated change with its idempotency key applies once', () =>
    withPlatform(async ({ core, client }) => {
        const idempotencyKey = newIdempotencyKey()
        // The platform applies the change but its response is lost, so the client repeats it.
        core.dropNextResponse()
        await client.call('publishNotification', { idempotencyKey, body: notification })
        await client.call('publishNotification', { idempotencyKey, body: notification })
        expect(core.notifications).toStrictEqual([notification])

        const changed = { ...notification, message: 'Another greeting is live.' }
        const reused = await problemOf(
            client.call('publishNotification', { idempotencyKey, body: changed }),
        )
        expect(reused.conflict).toBe(true)
        expect(reused.problem).toMatchObject({ status: 409, code: 'conflict' })
        expect(core.notifications).toHaveLength(1)
    }),
)

linuxTest('Durable operations settle, replay by key and can be cancelled', () =>
    withPlatform(async ({ client }) => {
        const signal = AbortSignal.timeout(5_000)
        const create = { idempotencyKey: newIdempotencyKey(), body: upsert }
        const accepted = await client.call('updateOwnedProxyHost', create)
        expect(accepted.status).toBe('accepted')
        expect(await client.call('updateOwnedProxyHost', create)).toMatchObject({ id: accepted.id })
        expect(await waitForOperation(client, accepted, signal, 10)).toStrictEqual({
            id: accepted.id,
            status: 'succeeded',
        })
        const { hosts } = await client.call('listProxyHosts', { body: { limit: 10 } })
        const [host] = hosts
        if (!host) throw new Error('The owned host is missing')
        expect(host).toMatchObject({ id: upsert.hostId, hostname: upsert.hostname })

        // A change based on an outdated revision fails and leaves the host as it is.
        const outdated = { idempotencyKey: newIdempotencyKey(), body: upsert }
        const conflicting = await client.call('updateOwnedProxyHost', outdated)
        expect(await waitForOperation(client, conflicting, signal, 10)).toMatchObject({
            status: 'failed',
            problem: { status: 409, code: 'hostRevisionConflict' },
        })

        const removal = {
            action: 'remove',
            hostId: host.id,
            expectedRevision: host.revision,
        } as const
        const pending = await client.call('updateOwnedProxyHost', {
            idempotencyKey: newIdempotencyKey(),
            body: removal,
        })
        const cancel = { pathParameter: pending.id, idempotencyKey: newIdempotencyKey() }
        expect(await client.call('cancelOperation', cancel)).toStrictEqual({
            id: pending.id,
            status: 'cancelled',
        })
        expect(await waitForOperation(client, pending, signal, 10)).toMatchObject({
            status: 'cancelled',
        })
    }),
)

linuxTest('The event stream resumes by cursor and resynchronizes after 410', () =>
    withPlatform(async ({ core, client }) => {
        core.publishEvent('proxyHostUpdated', 'host-1')
        core.publishEvent('proxyHostUpdated', 'host-2')
        const first = await firstEvent(client.events())
        expect(first).toMatchObject({ type: 'proxyHostUpdated', resourceId: 'host-1' })
        expect(await firstEvent(client.events(first.cursor))).toMatchObject({
            resourceId: 'host-2',
        })

        core.expireEvents()
        const expired = await problemOf(firstEvent(client.events(first.cursor)))
        expect(expired.cursorExpired).toBe(true)
        expect(expired.problem).toMatchObject({ status: 410, code: 'cursorExpired' })

        const following = new AbortController()
        const delivered: (string | undefined)[] = []
        let resyncs = 0
        await followPlatformEvents(client, {
            cursor: first.cursor,
            signal: following.signal,
            onResync: () => {
                resyncs += 1
                core.publishEvent('proxyHostCreated', 'host-3')
            },
            onEvent: (event) => {
                delivered.push(event.resourceId)
                following.abort()
            },
        })
        expect(resyncs).toBe(1)
        expect(delivered).toStrictEqual(['host-3'])
    }),
)

linuxTest('A stale generation (412) stops calls and the event stream', () =>
    withPlatform(async ({ core, client, connect }) => {
        // Another generation's headers or credential never pass core.sock either.
        for (const scope of [{ generation: 2 }, { credential: 'a'.repeat(43) }]) {
            const rejected = await problemOf(connect(scope).call('getPlatformContext'))
            expect(rejected.staleGeneration).toBe(true)
        }

        const following = followPlatformEvents(client, {
            signal: AbortSignal.timeout(5_000),
            onEvent: () => undefined,
            onResync: () => undefined,
        })
        await Bun.sleep(50)
        core.supersede()
        const stopped = await problemOf(following)
        expect(stopped.staleGeneration).toBe(true)
        expect(stopped.problem).toMatchObject({ status: 412, code: 'staleGeneration' })

        const stale = await problemOf(client.call('getPlatformContext'))
        expect(stale.problem.status).toBe(412)
    }),
)

linuxTest('A missing grant is not a stale generation', () =>
    withPlatform(async ({ client }) => {
        const change = { idempotencyKey: newIdempotencyKey(), body: notification }
        const denied = await problemOf(client.call('publishNotification', change))
        expect(denied.problem).toMatchObject({ status: 403, code: 'scopeDenied' })
        expect(denied.staleGeneration).toBe(false)
    }, []),
)

/** A core.sock stand-in whose handler decides every response, for transport edge cases. */
async function withRawCore(
    handler: (request: Request, attempt: number) => Response,
    run: (client: PlatformClient, attempts: () => number) => Promise<void>,
) {
    const directory = await mkdtemp('/tmp/rentnerproxy-raw-core-')
    const socket = join(directory, 'core.sock')
    let attempts = 0
    const server = Bun.serve({
        unix: socket,
        fetch: (request) => handler(request, (attempts += 1)),
    })
    try {
        const client = createPlatformClient({
            coreSocket: socket,
            coreAuthorization: 'Bearer ' + 'a'.repeat(43),
            installationId,
            generation: 1,
        })
        await run(client, () => attempts)
    } finally {
        await server.stop(true)
        await rm(directory, { recursive: true, force: true })
    }
}

linuxTest('A repeatable call is repeated when its response is lost while it arrives', () => {
    const context = parseProtocolDocument('PlatformContext', {
        appId: app.id,
        installationId,
        generation: 1,
        runtimeProfile: app.requires.runtimeProfile,
        versions: { appProtocol: '1.0.0', platformApi: '1.0.0', uiBridge: '1.0.0' },
        capabilities: grants,
    })
    return withRawCore(
        (_request, attempt) => {
            if (attempt > 1) return Response.json(context)
            // The connection breaks after the first bytes of the body.
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"appId":'))
                    controller.error(new Error('connection lost'))
                },
            })
            return new Response(body, { headers: { 'Content-Type': 'application/json' } })
        },
        async (client, attempts) => {
            expect(await client.call('getPlatformContext')).toMatchObject({ installationId })
            expect(attempts()).toBe(2)
        },
    )
})

linuxTest('An oversized event never reaches the app and is not fetched again forever', () => {
    const data = JSON.stringify({ padding: 'x'.repeat(rpcLimits.maxJsonBytes) })
    return withRawCore(
        () =>
            new Response(`data: ${data}\n\n`, {
                headers: { 'Content-Type': 'text/event-stream' },
            }),
        async (client, attempts) => {
            const delivered: PlatformEvent[] = []
            const following = followPlatformEvents(client, {
                signal: AbortSignal.timeout(5_000),
                onEvent: (event) => {
                    delivered.push(event)
                },
                onResync: () => undefined,
            })
            await expect(following).rejects.toBeInstanceOf(PlatformEventError)
            expect(delivered).toStrictEqual([])
            expect(attempts()).toBe(1)
        },
    )
})

linuxTest('An event with invalid UTF-8 is final and never reaches the app', () => {
    const invalid = new Uint8Array([...new TextEncoder().encode('data: {"x":"'), 0xff, 0x22, 0x7d])
    return withRawCore(
        () =>
            new Response(new Blob([invalid, new TextEncoder().encode('\n\n')]), {
                headers: { 'Content-Type': 'text/event-stream' },
            }),
        async (client, attempts) => {
            const delivered: PlatformEvent[] = []
            const following = followPlatformEvents(client, {
                signal: AbortSignal.timeout(5_000),
                onEvent: (event) => {
                    delivered.push(event)
                },
                onResync: () => undefined,
            })
            await expect(following).rejects.toBeInstanceOf(PlatformEventError)
            expect(delivered).toStrictEqual([])
            expect(attempts()).toBe(1)
        },
    )
})

linuxTest('A reply that cannot be decoded is not requested again', () =>
    withRawCore(
        () =>
            new Response(new Uint8Array([0x7b, 0xff, 0x7d]), {
                headers: { 'Content-Type': 'application/json' },
            }),
        async (client, attempts) => {
            await expect(client.call('getPlatformContext')).rejects.toThrow()
            expect(attempts()).toBe(1)
        },
    ),
)
