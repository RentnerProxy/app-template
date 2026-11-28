import appConfig from '../../app.config.json'
import { matchesVersions, type readBootstrap } from './bootstrap.ts'
import type { PlatformClient } from './platform-client.ts'

type Bootstrap = Awaited<ReturnType<typeof readBootstrap>>

const coreTimeoutMs = 3000
const requestedCapabilities: readonly { id: string; scope: string }[] = appConfig.capabilities

/** Verify that core.sock serves this installation generation before the app reports readiness. */
export async function verifyPlatformContextService(
    platform: PlatformClient,
    bootstrap: Bootstrap,
): Promise<void> {
    // The client repeats the read while the isolated smoke still starts its Core probe.
    const context = await platform.call('getPlatformContext', {
        signal: AbortSignal.timeout(coreTimeoutMs),
    })
    if (
        context.appId !== bootstrap.appId ||
        context.installationId !== bootstrap.installationId ||
        context.generation !== bootstrap.generation ||
        context.runtimeProfile !== bootstrap.runtimeProfile ||
        !matchesVersions(context.versions, bootstrap.versions) ||
        !context.capabilities.every((grant) =>
            requestedCapabilities.some(({ id, scope }) => grant.id === id && grant.scope === scope),
        )
    ) {
        throw new Error('Invalid platform context')
    }
}
