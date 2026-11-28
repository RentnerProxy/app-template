import { randomUUID, timingSafeEqual } from 'node:crypto'

import {
    httpOperations,
    parseProtocolDocument,
    rpcLimits,
    type HttpOperationName,
    type ProtocolDocument,
} from '@rentnerproxy/app-contracts'

import { hasJsonContentType, readJson } from '../../src/server/json.ts'

type PlatformContext = ProtocolDocument<'PlatformContext'>
interface DurableChange {
    operation: ProtocolDocument<'Operation'>
    change: ProtocolDocument<'OwnedProxyHostChange'>
}

interface DevCoreOptions {
    socket: string
    credential: string
    context: PlatformContext
    rejectContext?: boolean
}

interface Route {
    name: HttpOperationName
    parameter: string | undefined
    idempotencyKey: string | undefined
    body: unknown
}

const routes = (
    Object.entries(httpOperations) as [
        HttpOperationName,
        (typeof httpOperations)[HttpOperationName],
    ][]
).filter(([, { socket }]) => socket === 'core.sock')
// Manifest capabilities the stub requires. It grants support capabilities such as events itself.
const requiredCapabilities: Partial<Record<HttpOperationName, string>> = {
    listProxyHosts: 'proxy.hosts.read.v1',
    updateOwnedProxyHost: 'proxy.hosts.manage-owned.v1',
    publishNotification: 'notifications.publish.v1',
}
const encoder = new TextEncoder()

function problem(status: number, code: string, title: string) {
    return Response.json(
        { type: 'urn:rentnerproxy:problem:' + code, title, status, code, requestId: randomUUID() },
        { status, headers: { 'Content-Type': 'application/problem+json' } },
    )
}

const noContent = () => new Response(null, { status: 204 })

function match(method: string, pathname: string) {
    for (const [name, operation] of routes) {
        if (operation.method !== method) continue
        if (!('pathParameter' in operation)) {
            if (pathname === operation.path) return { name, operation, parameter: undefined }
            continue
        }
        const [prefix = '', suffix = ''] = operation.path.split(/\{\w+\}/u)
        const parameter = pathname.slice(prefix.length, pathname.length - suffix.length)
        if (
            pathname.startsWith(prefix) &&
            pathname.endsWith(suffix) &&
            /^[^/]+$/u.test(parameter)
        ) {
            return { name, operation, parameter }
        }
    }
}

/** Simulate the core.sock platform API of one installation generation from the published contract. */
export function startDevCore({
    socket,
    credential,
    context,
    rejectContext = false,
}: DevCoreOptions) {
    const authorization = Buffer.from('Bearer ' + credential)
    const receipts = new Map<string, { fingerprint: string; reply: () => Response }>()
    const operations = new Map<string, DurableChange>()
    const hosts = new Map<string, { id: string; revision: string; hostname: string }>()
    const notifications: unknown[] = []
    const auditEvents: unknown[] = []
    const retained: { sequence: number; frame: Uint8Array }[] = []
    const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
    let sequence = 0
    let floor = 0
    let contextCalls = 0
    let superseded = false
    let dropNextResponse = false

    function granted(id: string) {
        return context.capabilities.some((capability) => capability.id === id)
    }

    function publishEvent(type: string, resourceId: string, fields?: object) {
        sequence += 1
        const event = {
            id: randomUUID(),
            cursor: 'cursor-' + sequence,
            type,
            occurredAt: new Date().toISOString(),
            resourceId,
            ...fields,
        }
        const frame = encoder.encode(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)
        retained.push({ sequence, frame })
        for (const stream of streams) {
            try {
                stream.enqueue(frame)
            } catch {
                streams.delete(stream)
            }
        }
    }

    function closeStreams() {
        for (const stream of streams) {
            try {
                stream.close()
            } catch {
                // The subscriber already disconnected.
            }
        }
        streams.clear()
    }

    /** Apply a change once per idempotency key and replay its reply for the same input. */
    function once(route: Route, apply: () => () => Response) {
        const id = route.name + ':' + route.idempotencyKey
        const fingerprint = JSON.stringify([route.parameter, route.body])
        const receipt = receipts.get(id)
        if (receipt && receipt.fingerprint !== fingerprint) {
            return problem(409, 'conflict', 'App operation conflicts with current state.')
        }
        const reply = receipt?.reply ?? apply()
        receipts.set(id, { fingerprint, reply })
        if (!receipt && dropNextResponse) {
            dropNextResponse = false
            return problem(503, 'platformUnavailable', 'Service Unavailable')
        }
        return reply()
    }

    /** Advance accepted work one step per read, like a platform worker would. */
    function advance(entry: DurableChange) {
        const { operation, change } = entry
        if (operation.status === 'accepted') {
            entry.operation = { id: operation.id, status: 'running' }
            return
        }
        if (operation.status !== 'running') return
        const current = hosts.get(change.hostId)
        if ((current?.revision ?? null) !== change.expectedRevision) {
            const code = 'hostRevisionConflict'
            const title = 'Proxy host changed before its apply'
            const failure = { type: 'urn:rentnerproxy:problem:' + code, title, status: 409, code }
            entry.operation = {
                id: operation.id,
                status: 'failed',
                problem: { ...failure, requestId: randomUUID() },
            }
            return
        }
        const revision = randomUUID()
        if (change.action === 'remove') hosts.delete(change.hostId)
        else hosts.set(change.hostId, { id: change.hostId, revision, hostname: change.hostname })
        const type =
            change.action === 'remove'
                ? 'proxyHostRemoved'
                : current
                  ? 'proxyHostUpdated'
                  : 'proxyHostCreated'
        publishEvent(type, change.hostId, { revision })
        entry.operation = { id: operation.id, status: 'succeeded' }
    }

    function subscribe(cursor: string | null) {
        const position = cursor === null ? floor : Number(/^cursor-([1-9]\d*)$/u.exec(cursor)?.[1])
        if (!(position >= floor && position <= sequence)) {
            return problem(410, 'cursorExpired', 'Resynchronize authorized app state.')
        }
        let opened: ReadableStreamDefaultController<Uint8Array> | undefined
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                opened = controller
                controller.enqueue(encoder.encode(': connected\n\n'))
                for (const event of retained) {
                    if (event.sequence > position) controller.enqueue(event.frame)
                }
                streams.add(controller)
            },
            cancel() {
                if (opened) streams.delete(opened)
            },
        })
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }

    function dispatch(route: Route, request: Request): Response {
        const { name, parameter = '', body } = route
        switch (name) {
            case 'getPlatformContext':
                if (rejectContext) {
                    return problem(403, 'installationContextRejected', 'Forbidden')
                }
                contextCalls += 1
                return Response.json(context)
            case 'checkAuthorization': {
                const { capability, resourceId } = parseProtocolDocument(
                    'AuthorizationRequest',
                    body,
                )
                const allowed =
                    granted(capability.id) &&
                    (capability.scope !== 'installation' || resourceId === context.installationId)
                return Response.json({ allowed })
            }
            case 'listProxyHosts':
                return Response.json({ hosts: [...hosts.values()] })
            case 'publishNotification':
            case 'recordAuditEvent':
                return once(route, () => {
                    const notification = name === 'publishNotification'
                    ;(notification ? notifications : auditEvents).push(body)
                    const type = notification ? 'appNotificationPublished' : 'appAuditRecorded'
                    publishEvent(type, context.installationId, { payload: body })
                    return noContent
                })
            case 'updateOwnedProxyHost':
                return once(route, () => {
                    const entry: DurableChange = {
                        operation: { id: randomUUID(), status: 'accepted' },
                        change: parseProtocolDocument('OwnedProxyHostChange', body),
                    }
                    operations.set(entry.operation.id, entry)
                    // A retry replays the original reply, not the operation's later state.
                    const accepted = { ...entry.operation }
                    return () => Response.json(accepted, { status: 202 })
                })
            case 'getOperation':
            case 'cancelOperation': {
                const entry = operations.get(parameter)
                if (!entry) return problem(404, 'notFound', 'App resource is unavailable.')
                if (name === 'getOperation') {
                    advance(entry)
                    return Response.json(entry.operation)
                }
                return once(route, () => {
                    if (entry.operation.status === 'accepted') {
                        entry.operation = { id: entry.operation.id, status: 'cancelled' }
                    }
                    const reply = { ...entry.operation }
                    return () => Response.json(reply, { status: 202 })
                })
            }
            case 'subscribeToEvents':
                return subscribe(request.headers.get('Last-Event-ID'))
            default:
                return problem(501, 'notImplemented', 'Not simulated by the local Platform stub')
        }
    }

    const server = Bun.serve({
        unix: socket,
        development: false,
        maxRequestBodySize: rpcLimits.maxJsonBytes,
        async fetch(request) {
            const presented = Buffer.from(request.headers.get('Authorization') ?? '')
            if (
                presented.length !== authorization.length ||
                !timingSafeEqual(presented, authorization)
            ) {
                return problem(401, 'appCredentialRejected', 'Unauthorized')
            }
            if (
                request.headers.get('X-App-Installation') !== context.installationId ||
                request.headers.get('X-App-Generation') !== String(context.generation)
            ) {
                return problem(403, 'installationContextRejected', 'Forbidden')
            }
            if (superseded) {
                return problem(412, 'staleGeneration', 'A newer app generation replaced this one.')
            }
            const { pathname, search } = new URL(request.url)
            const found = search ? undefined : match(request.method, pathname)
            if (!found) return problem(404, 'operationNotFound', 'Not Found')
            const { name, operation, parameter } = found
            const required = requiredCapabilities[name]
            if (required && !granted(required)) {
                return problem(403, 'scopeDenied', 'App operation is outside the current grant.')
            }
            const idempotencyKey = request.headers.get('Idempotency-Key') ?? undefined
            let body: unknown
            try {
                if (parameter !== undefined) parseProtocolDocument('RecordId', parameter)
                if ('idempotencyKey' in operation) parseProtocolDocument('RecordId', idempotencyKey)
                if ('request' in operation) {
                    if (!request.body || !hasJsonContentType(request.headers)) throw new Error()
                    body = parseProtocolDocument(
                        operation.request,
                        await readJson(request.body, rpcLimits.maxJsonBytes),
                    )
                }
            } catch {
                return problem(400, 'invalidRequest', 'Invalid App API request.')
            }
            return dispatch({ name, parameter, idempotencyKey, body }, request)
        },
    })

    return {
        contextCalls: () => contextCalls,
        notifications: notifications as readonly unknown[],
        auditEvents: auditEvents as readonly unknown[],
        publishEvent,
        /** Answer the next new idempotent change with 503 after applying it, like a lost response. */
        dropNextResponse() {
            dropNextResponse = true
        },
        /** Drop retained events so older cursors expire (410). */
        expireEvents() {
            floor = sequence
            retained.length = 0
        },
        /** Replace this generation: open streams close and later requests get 412. */
        supersede() {
            superseded = true
            closeStreams()
        },
        async stop() {
            closeStreams()
            await server.stop(true)
        },
    }
}
