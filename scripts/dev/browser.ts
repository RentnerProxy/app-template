import { isGeneration, isRecord, isRecordId, readGreeting } from '../../src/lib/greeting.ts'

declare const GREETING_ASSET_PREFIX: string

function requiredElement<ElementType extends Element>(selector: string) {
    const element = document.querySelector<ElementType>(selector)
    if (!element) throw new Error('Missing local Platform control: ' + selector)
    return element
}

const holder = requiredElement<HTMLDivElement>('#frame-slot')
const theme = requiredElement<HTMLSelectElement>('#theme')
const locale = requiredElement<HTMLSelectElement>('#locale')
const route = requiredElement<HTMLSelectElement>('#route')
const ready = requiredElement<HTMLInputElement>('#app-ready')
const dialog = requiredElement<HTMLDialogElement>('dialog')
const failure = requiredElement<HTMLElement>('#bridge-failed')
const installId = document.body.dataset.installationId
const installationGeneration = Number(document.body.dataset.installationGeneration)
if (!isRecordId(installId) || !isGeneration(installationGeneration)) {
    throw new Error('Missing local Platform installation context')
}
const installation = { installId, installationGeneration }
/** How long a frame has to load, announce itself and connect, each counted from its own start. */
const handshakeMs = 5_000
let generation = 0
let requests = 0
let bridge: ReturnType<typeof openBridge> | undefined

function openBridge(nextGeneration: number) {
    const binding = { ...installation, generation: nextGeneration }
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('')
    const frame = document.createElement('iframe')
    frame.id = 'greeting-app'
    frame.title = 'Greeting app'
    frame.width = '800'
    frame.height = '450'
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.src =
        GREETING_ASSET_PREFIX + 'index.html#' + new URLSearchParams({ nonce, slot: 'navigation' })

    let control: MessagePort | undefined
    let session: MessagePort | undefined
    let dialogRequest: string | undefined
    let loaded = false
    let connected = false
    let closed = false
    const pending = new Set<string>()
    const active = new AbortController()
    let handshakeTimeout = window.setTimeout(fail, handshakeMs)

    function close() {
        if (closed) return
        closed = true
        active.abort()
        clearTimeout(handshakeTimeout)
        control?.close()
        session?.close()
        if (dialogRequest) {
            dialogRequest = undefined
            dialog.close()
        }
    }

    /** Never end a session silently: close it and tell the developer, who can reload the app. */
    function fail() {
        if (closed) return
        close()
        frame.remove()
        failure.hidden = false
    }

    function sendContext() {
        if (!connected || closed) return
        session?.postMessage({
            type: 'context',
            ...binding,
            theme: theme.value,
            locale: locale.value,
            route: route.value,
            ready: ready.checked,
        })
    }

    function receiveReady(event: MessageEvent<unknown>) {
        if (event.source !== frame.contentWindow) return
        const [transferred] = event.ports
        const message = event.data
        if (
            event.origin !== 'null' ||
            control ||
            !isRecord(message) ||
            message.type !== 'runtime:ready' ||
            message.nonce !== nonce ||
            !transferred ||
            event.ports.length !== 1
        ) {
            for (const port of event.ports) port.close()
            return
        }
        window.removeEventListener('message', receiveReady)
        control = transferred
        control.onmessageerror = fail
        control.onmessage = (event) => {
            for (const port of event.ports) port.close()
            fail()
        }
        // A frame that announced itself gets the full deadline to connect, however late it did.
        clearTimeout(handshakeTimeout)
        handshakeTimeout = window.setTimeout(fail, handshakeMs)
        control.start()
        bootstrap()
    }

    function receiveLoad() {
        if (loaded) {
            fail()
            return
        }
        loaded = true
        bootstrap()
    }

    function bootstrap() {
        if (!loaded || !control || session || closed) return
        const channel = new MessageChannel()
        session = channel.port1
        session.onmessageerror = fail
        session.onmessage = receiveSession
        session.start()
        control.postMessage({ type: 'runtime:bootstrap', bridgeVersion: '1.0.0', ...binding }, [
            channel.port2,
        ])
    }

    function receiveSession(event: MessageEvent<unknown>) {
        for (const port of event.ports) port.close()
        const message = event.data
        if (
            closed ||
            event.ports.length !== 0 ||
            !isRecord(message) ||
            message.installId !== binding.installId ||
            message.installationGeneration !== binding.installationGeneration ||
            message.generation !== binding.generation
        ) {
            return
        }
        if (!connected) {
            if (message.type === 'connected') {
                connected = true
                clearTimeout(handshakeTimeout)
                sendContext()
            }
            return
        }
        if (
            message.type === 'navigate' &&
            (message.route === 'overview' || message.route === 'details')
        ) {
            route.value = message.route
            sendContext()
            return
        }
        const requestId = message.requestId
        if (!isRecordId(requestId) || pending.has(requestId) || dialogRequest === requestId) return
        if (message.type === 'dialog' && message.dialogId === 'confirm-save') {
            if (dialogRequest) {
                sendDialogResult(requestId, 'cancelled')
                return
            }
            dialogRequest = requestId
            dialog.showModal()
            return
        }
        if (message.type !== 'apiRequest' || !isRecordId(message.idempotencyKey)) return
        if (!ready.checked) {
            sendApiResult(requestId, undefined)
            return
        }
        const { operationId, idempotencyKey, payload } = message
        if (
            operationId === 'get-greeting' &&
            isRecord(payload) &&
            Object.keys(payload).length === 0
        ) {
            dispatchGreeting(requestId, operationId, idempotencyKey, {})
        } else if (operationId === 'save-greeting') {
            const greeting = readGreeting(payload)
            if (greeting !== undefined) {
                dispatchGreeting(requestId, operationId, idempotencyKey, { greeting })
            }
        }
    }

    function sendDialogResult(requestId: string, outcome: 'confirmed' | 'cancelled') {
        if (!closed) session?.postMessage({ type: 'dialogResult', ...binding, requestId, outcome })
    }

    function settleDialog(outcome: 'confirmed' | 'cancelled') {
        if (!dialogRequest) return
        sendDialogResult(dialogRequest, outcome)
        dialogRequest = undefined
        dialog.close()
    }

    function dispatchGreeting(
        requestId: string,
        operationId: 'get-greeting' | 'save-greeting',
        idempotencyKey: string,
        payload: Record<string, string>,
    ) {
        if (pending.size >= 8) {
            sendApiResult(requestId, undefined)
            return
        }
        // Serialize first: a payload that cannot be sent must not hold a slot nothing would free.
        let body: string
        try {
            body = JSON.stringify({ operationId, idempotencyKey, payload })
        } catch {
            sendApiResult(requestId, undefined)
            return
        }
        requests += 1
        document.body.dataset.appRpcs = String(requests)
        pending.add(requestId)
        void fetch('/dev/v1/greeting', {
            signal: active.signal,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        })
            .then(async (response) => {
                const greeting = response.ok ? readGreeting(await response.json()) : undefined
                sendApiResult(requestId, greeting)
            })
            .catch(() => sendApiResult(requestId, undefined))
            .finally(() => pending.delete(requestId))
            .catch(fail)
    }

    function sendApiResult(requestId: string, greeting: string | undefined) {
        if (closed) return
        const result =
            greeting === undefined
                ? {
                      ok: false,
                      problem: {
                          requestId,
                          status: 502,
                          type: 'urn:rentnerproxy:problem:unavailable',
                          code: 'unavailable',
                          title: 'Greeting operation unavailable',
                      },
                  }
                : { ok: true, payload: { greeting } }
        session?.postMessage({ type: 'apiResult', ...binding, requestId, result })
    }

    window.addEventListener('message', receiveReady, { signal: active.signal })
    frame.addEventListener('load', receiveLoad, { signal: active.signal })
    holder.replaceChildren(frame)
    return { close, isClosed: () => closed, sendContext, settleDialog }
}

function replaceFrame() {
    bridge?.close()
    failure.hidden = true
    route.value = 'overview'
    generation += 1
    document.body.dataset.generation = String(generation)
    bridge = openBridge(generation)
}

for (const control of [theme, locale, route, ready]) {
    control.addEventListener('change', () => bridge?.sendContext())
}
requiredElement('#replace-frame').addEventListener('click', replaceFrame)
requiredElement('#retry-frame').addEventListener('click', replaceFrame)
requiredElement('#confirm-save').addEventListener('click', () => bridge?.settleDialog('confirmed'))
requiredElement('#cancel-save').addEventListener('click', () => bridge?.settleDialog('cancelled'))
dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    bridge?.settleDialog('cancelled')
})
// A page kept for Back and Forward keeps its frame and ports, so only a real unload closes them.
window.addEventListener('pagehide', (event) => {
    if (!event.persisted) bridge?.close()
})
window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return
    if (bridge?.isClosed()) replaceFrame()
    else bridge?.sendContext()
})
replaceFrame()
