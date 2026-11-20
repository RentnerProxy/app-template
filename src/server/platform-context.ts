import { isRecord } from '@/lib/greeting.ts'

import appConfig from '../../app.config.json'
import { matchesVersions, type readBootstrap } from './bootstrap.ts'
import { hasJsonContentType, readJson } from './json.ts'

type Bootstrap = Awaited<ReturnType<typeof readBootstrap>>

const coreTimeoutMs = 3000
const requestedCapabilities: readonly { id: string; scope: string }[] = appConfig.capabilities

async function fetchPlatformContext(bootstrap: Bootstrap, signal: AbortSignal): Promise<Response> {
    while (true) {
        try {
            return await fetch('http://localhost/platform/v1/context', {
                unix: bootstrap.coreSocket,
                method: 'GET',
                redirect: 'error',
                signal,
                headers: {
                    Accept: 'application/json',
                    Authorization: bootstrap.coreAuthorization,
                    'X-App-Installation': bootstrap.installationId,
                    'X-App-Generation': String(bootstrap.generation),
                },
            })
        } catch (error) {
            if (signal.aborted) throw error
            // The isolated smoke starts the Core probe and the app concurrently.
            await Bun.sleep(25)
        }
    }
}

export async function verifyPlatformContextService(bootstrap: Bootstrap): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), coreTimeoutMs)
    try {
        const response = await fetchPlatformContext(bootstrap, controller.signal)
        if (response.status !== 200 || !hasJsonContentType(response.headers) || !response.body) {
            throw new Error('Platform context request failed')
        }
        const context = await readJson(response.body)
        if (
            !isRecord(context) ||
            context.appId !== bootstrap.appId ||
            context.installationId !== bootstrap.installationId ||
            context.generation !== bootstrap.generation ||
            context.runtimeProfile !== bootstrap.runtimeProfile ||
            !matchesVersions(context.versions, bootstrap.versions) ||
            !Array.isArray(context.capabilities) ||
            !context.capabilities.every(
                (grant: unknown) =>
                    isRecord(grant) &&
                    requestedCapabilities.some(
                        ({ id, scope }) => grant.id === id && grant.scope === scope,
                    ),
            )
        ) {
            throw new Error('Invalid platform context')
        }
    } finally {
        clearTimeout(timeout)
        controller.abort()
    }
}
