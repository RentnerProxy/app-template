import { setTimeout as delay } from 'node:timers/promises'

import {
    ContractError,
    parseHttpEvent,
    parseHttpResponse,
    prepareHttpRequest,
    rpcLimits,
    type httpOperations,
    type HttpOperationName,
    type HttpRequest,
    type HttpRequestOptions,
    type HttpResponse,
    type ProtocolDocument,
} from '@rentnerproxy/app-contracts'

import { JsonSizeError, parseJsonBytes, readBytes } from './json.ts'

type Operations = typeof httpOperations

/** Platform API operations on core.sock, as the published app contract declares them. */
export type PlatformOperation = {
    [Name in HttpOperationName]: Operations[Name]['socket'] extends 'core.sock' ? Name : never
}[HttpOperationName]
type CallOperation = Exclude<PlatformOperation, 'subscribeToEvents'>

export type PlatformResult<Name extends PlatformOperation> = Extract<
    HttpResponse<Name>,
    { ok: true }
>['data']
export type PlatformEvent = ProtocolDocument<'PlatformEvent'>
export type DurableOperation = ProtocolDocument<'Operation'>
type Problem = ProtocolDocument<'Problem'>

// The path parameter, idempotency key and body each operation requires, derived from the contract.
type PathControl<Operation> = Operation extends { pathParameter: string }
    ? { pathParameter: string }
    : { pathParameter?: never }
type KeyControl<Operation> = Operation extends { idempotencyKey: true }
    ? { idempotencyKey: string }
    : { idempotencyKey?: never }
type BodyControl<Name extends CallOperation> = Operations[Name] extends { request: string }
    ? { body: HttpRequest<Name>['body'] }
    : { body?: never }
type CallOptions<Name extends CallOperation> = PathControl<Operations[Name]> &
    KeyControl<Operations[Name]> &
    BodyControl<Name> & { signal?: AbortSignal }
type CallArguments<Name extends CallOperation> =
    Partial<CallOptions<Name>> extends CallOptions<Name>
        ? [options?: CallOptions<Name>]
        : [options: CallOptions<Name>]

export interface PlatformBinding {
    coreSocket: string
    coreAuthorization: string
    installationId: string
    generation: number
}

export class PlatformApiError extends Error {
    constructor(
        readonly operation: PlatformOperation,
        readonly problem: Problem,
    ) {
        super(`${operation} failed with ${problem.status} ${problem.code}`)
        this.name = 'PlatformApiError'
    }

    /**
     * The platform replaced this generation (412), or its credential and lease are no longer
     * current (401, or 403 when the installation context is rejected). Retrying cannot succeed:
     * stop background work and let the platform drain this process.
     */
    get staleGeneration() {
        const { status, code } = this.problem
        return (
            status === 412 ||
            status === 401 ||
            (status === 403 && code === 'installationContextRejected')
        )
    }

    /** The idempotency key was used for different input, or the change conflicts with current state. */
    get conflict() {
        return this.problem.status === 409
    }

    /** The event cursor expired. Resynchronize from authorized reads and subscribe without it. */
    get cursorExpired() {
        return this.problem.status === 410
    }
}

/** An event that cannot be accepted, such as an oversized one. Reconnecting delivers it again. */
export class PlatformEventError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'PlatformEventError'
    }
}

/**
 * Create a key once per intended change and reuse it for every retry, also after a restart.
 * The platform then applies the change once; the same key with different input conflicts (409).
 */
export function newIdempotencyKey() {
    return crypto.randomUUID()
}

function pause(milliseconds: number, signal?: AbortSignal) {
    return delay(milliseconds, undefined, { signal }).catch(() => undefined)
}

export function createPlatformClient(binding: PlatformBinding) {
    const scope = {
        Authorization: binding.coreAuthorization,
        'X-App-Installation': binding.installationId,
        'X-App-Generation': String(binding.generation),
    }

    function send(request: HttpRequest<PlatformOperation>, signal?: AbortSignal) {
        return fetch('http://localhost' + request.path, {
            unix: binding.coreSocket,
            method: request.method,
            redirect: 'error',
            signal: signal ?? null,
            headers: {
                ...request.headers,
                ...scope,
                ...(request.body !== undefined && { 'Content-Type': 'application/json' }),
            },
            body: request.body === undefined ? null : JSON.stringify(request.body),
        })
    }

    /** Read the body bytes. Only transport failures and the size limit can occur here. */
    function receive(response: Response) {
        return response.status === 204 || !response.body
            ? undefined
            : readBytes(response.body, rpcLimits.maxJsonBytes)
    }

    function result<Name extends PlatformOperation>(
        name: Name,
        status: number,
        bytes: Uint8Array | undefined,
    ) {
        const body = bytes === undefined ? undefined : parseJsonBytes(bytes)
        const parsed = parseHttpResponse(name, status, body)
        if (!parsed.ok) throw new PlatformApiError(name, parsed.problem)
        return parsed.data
    }

    /**
     * Call a platform operation. Reads and changes with an idempotency key are repeated with the
     * same key when the platform is briefly unreachable or the response is lost while it arrives,
     * so a change never applies twice. Invalid responses and platform problems are not repeated.
     */
    async function call<Name extends CallOperation>(
        name: Name,
        ...args: CallArguments<Name>
    ): Promise<PlatformResult<Name>> {
        const [options = {}] = args as [(HttpRequestOptions & { signal?: AbortSignal })?]
        const { signal: caller, ...controls } = options
        const deadline = AbortSignal.timeout(rpcLimits.defaultDeadlineMs)
        const signal = caller ? AbortSignal.any([caller, deadline]) : deadline
        const request = prepareHttpRequest(name, controls)
        const repeatable = request.method === 'GET' || controls.idempotencyKey !== undefined
        for (let attempt = 0; ; attempt += 1) {
            let received: { status: number; bytes: Uint8Array | undefined } | undefined
            try {
                const response = await send(request, signal)
                if (repeatable && (response.status === 503 || response.status === 504)) {
                    await response.body?.cancel()
                } else {
                    received = { status: response.status, bytes: await receive(response) }
                }
            } catch (error) {
                // Only the transport can fail while sending and receiving, besides the size limit.
                if (!repeatable || error instanceof JsonSizeError || signal.aborted) throw error
            }
            // Decoding, JSON, contract and platform errors are final: the same reply fails again.
            if (received) return result(name, received.status, received.bytes)
            await pause(Math.min(25 * 2 ** attempt, 1_000), signal)
            signal.throwIfAborted()
        }
    }

    /** Open the durable event stream once, resuming after `cursor`. */
    async function* events(cursor?: string, signal?: AbortSignal): AsyncGenerator<PlatformEvent> {
        const options = cursor === undefined ? {} : { resumeCursor: cursor }
        const response = await send(prepareHttpRequest('subscribeToEvents', options), signal)
        if (response.status !== 200) {
            result('subscribeToEvents', response.status, await receive(response))
        }
        const [mediaType] = response.headers.get('Content-Type')?.split(';', 1) ?? []
        if (!response.body || mediaType?.trim() !== 'text/event-stream') {
            throw new Error('The platform did not open an event stream')
        }
        for await (const data of serverSentData(response.body)) {
            yield parseHttpEvent('subscribeToEvents', JSON.parse(data))
        }
    }

    return { call, events }
}

export type PlatformClient = ReturnType<typeof createPlatformClient>

/**
 * Yield the data of each Server-Sent Event. Comments such as keepalives carry none. An event over
 * the JSON size limit or with invalid UTF-8 is rejected before it is yielded, whatever the chunk
 * boundaries are. Failures of the stream itself stay transport errors.
 */
async function* serverSentData(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const limit = rpcLimits.maxJsonBytes
    let pending = ''
    let data: string[] = []
    let size = 0
    const oversized = () => new PlatformEventError('A platform event exceeds the size limit')
    const decode = (chunk: Uint8Array) => {
        try {
            return decoder.decode(chunk, { stream: true })
        } catch {
            throw new PlatformEventError('A platform event is not valid UTF-8')
        }
    }
    for await (const chunk of stream) {
        const lines = (pending + decode(chunk)).split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines.map((value) => value.replace(/\r$/u, ''))) {
            if (line === '') {
                if (data.length > 0) yield data.join('\n')
                data = []
                size = 0
            } else if (line.startsWith('data:')) {
                const value = line.slice(line.startsWith('data: ') ? 6 : 5)
                size += Buffer.byteLength(value) + (data.length > 0 ? 1 : 0)
                if (size > limit) throw oversized()
                data.push(value)
            }
        }
        if (size + Buffer.byteLength(pending) > limit) throw oversized()
    }
}

interface FollowOptions {
    /** The cursor of the last event this app processed durably, if any. */
    cursor?: string
    signal: AbortSignal
    /** Apply one event idempotently, then persist `event.cursor`. Events arrive at least once. */
    onEvent: (event: PlatformEvent) => Promise<void> | void
    /** The cursor expired. Rebuild state from authorized reads; delivery restarts at the oldest retained event. */
    onResync: () => Promise<void> | void
}

function isTransient(error: unknown) {
    if (error instanceof PlatformApiError) {
        return error.problem.status === 429 || error.problem.status >= 500
    }
    return !(
        error instanceof ContractError ||
        error instanceof SyntaxError ||
        error instanceof PlatformEventError ||
        error instanceof JsonSizeError
    )
}

/** Keep the durable event stream open: resume after disconnects and resynchronize after 410. */
export async function followPlatformEvents(client: PlatformClient, options: FollowOptions) {
    const { signal } = options
    let { cursor } = options
    while (!signal.aborted) {
        try {
            for await (const event of client.events(cursor, signal)) {
                await options.onEvent(event)
                cursor = event.cursor
            }
        } catch (error) {
            if (signal.aborted) return
            if (error instanceof PlatformApiError && error.cursorExpired) {
                await options.onResync()
                cursor = undefined
                continue
            }
            // A stale generation, a missing grant or an invalid event does not heal by reconnecting.
            if (!isTransient(error)) throw error
        }
        await pause(1_000, signal)
    }
}

const settled = new Set(['succeeded', 'failed', 'cancelled'])

/** Poll a durable operation until it settles. A timeout confirms neither success nor cancellation. */
export async function waitForOperation(
    client: PlatformClient,
    operation: DurableOperation,
    signal: AbortSignal,
    intervalMs = 1_000,
) {
    let current = operation
    while (!settled.has(current.status)) {
        await pause(intervalMs, signal)
        signal.throwIfAborted()
        current = await client.call('getOperation', { pathParameter: current.id, signal })
    }
    return current
}
