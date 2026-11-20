import { isGeneration, isRecord, isRecordId } from '@/lib/greeting.ts'

import appConfig from '../../app.config.json'
import { readJson } from './json.ts'

export const protocolVersion = '1.0.0'
const supportedVersions = {
    appProtocol: protocolVersion,
    platformApi: '1.0.0',
    uiBridge: '1.0.0',
}

export function matchesVersions(value: unknown, expected: typeof supportedVersions): boolean {
    return (
        isRecord(value) &&
        Object.keys(value).length === 3 &&
        value.appProtocol === expected.appProtocol &&
        value.platformApi === expected.platformApi &&
        value.uiBridge === expected.uiBridge
    )
}

function isSocketPath(value: unknown, filename: 'app.sock' | 'core.sock'): value is string {
    return (
        typeof value === 'string' &&
        value.startsWith('/') &&
        value.endsWith('/' + filename) &&
        value.length <= 107 &&
        value
            .slice(1)
            .split('/')
            .every((segment) => /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(segment))
    )
}

function isCredential(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/u.test(value)
}

function bootstrapStream() {
    const descriptor = process.env.RENTNERPROXY_APP_BOOTSTRAP_FD
    if (descriptor === '0') return Bun.stdin.stream()
    // The isolated Marketplace check passes its bootstrap on inherited fd 3.
    if (descriptor === undefined && Bun.argv.length === 3 && Bun.argv[2] === 'serve') {
        return Bun.file(3).stream()
    }
    throw new Error('Missing bootstrap')
}

export async function readBootstrap() {
    const value = await readJson(bootstrapStream())
    const { requires } = appConfig
    if (
        !isRecord(value) ||
        Object.keys(value).length !== 10 ||
        value.formatVersion !== 1 ||
        value.appId !== appConfig.id ||
        value.runtimeProfile !== 'rentnerproxy-linux-v1' ||
        value.runtimeProfile !== requires.runtimeProfile ||
        !isRecordId(value.installationId) ||
        !isGeneration(value.generation) ||
        !isSocketPath(value.appSocket, 'app.sock') ||
        !isSocketPath(value.coreSocket, 'core.sock') ||
        !isCredential(value.appCredential) ||
        !isCredential(value.coreCredential) ||
        value.appCredential === value.coreCredential ||
        !matchesVersions(value.versions, supportedVersions) ||
        !Bun.semver.satisfies(supportedVersions.appProtocol, requires.appProtocol) ||
        !Bun.semver.satisfies(supportedVersions.platformApi, requires.platformApi) ||
        !Bun.semver.satisfies(supportedVersions.uiBridge, requires.uiBridge)
    ) {
        throw new Error('Invalid bootstrap')
    }
    return {
        appId: value.appId,
        installationId: value.installationId,
        generation: value.generation,
        runtimeProfile: value.runtimeProfile,
        versions: supportedVersions,
        appSocket: value.appSocket,
        appAuthorization: Buffer.from(`Bearer ${value.appCredential}`),
        coreSocket: value.coreSocket,
        coreAuthorization: `Bearer ${value.coreCredential}`,
    }
}
