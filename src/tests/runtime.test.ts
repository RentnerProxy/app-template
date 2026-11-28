import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import app from '../../app.config.json'
import { startDevRuntime } from '../../scripts/dev/runtime.ts'
import { defaultGreeting } from '../lib/greeting.ts'

test.skipIf(process.platform !== 'linux')(
    'Greeting uses scoped v1 IPC and persists across restart',
    async () => {
        const dataDirectory = await mkdtemp(join(tmpdir(), 'greeting-runtime-test-'))
        const executable = process.env.GREETING_APP_EXECUTABLE
        const options = { dataDirectory, ...(executable && { executable }) }
        const greeting = 'Gude from the runtime smoke!'

        try {
            await expect(startDevRuntime({ ...options, rejectContext: true })).rejects.toThrow(
                'Greeting app exited before readiness',
            )
            const first = await startDevRuntime(options)
            try {
                expect(first.contextCalls()).toBe(1)
                const context = await first.fetchCore()
                expect(context.status).toBe(200)
                expect(await context.json()).toStrictEqual({
                    appId: app.id,
                    installationId: first.installationId,
                    generation: first.generation,
                    runtimeProfile: app.requires.runtimeProfile,
                    versions: { appProtocol: '1.0.0', platformApi: '1.0.0', uiBridge: '1.0.0' },
                    capabilities: [],
                })
                const deniedContext = await first.fetchCore({ credential: 'a'.repeat(43) })
                expect(deniedContext.status).toBe(401)
                expect(await deniedContext.json()).toMatchObject({
                    status: 401,
                    code: 'appCredentialRejected',
                })
                expect(first.contextCalls()).toBe(2)
                const health = await first.fetchApp('health')
                expect(health.status).toBe(200)
                expect(await health.json()).toStrictEqual({ healthy: true })
                const ready = await first.fetchApp('ready')
                expect(ready.status).toBe(200)
                expect(await ready.json()).toStrictEqual({
                    ready: true,
                    protocolVersion: '1.0.0',
                    dataVersion: app.data.targetVersion,
                    providers: [],
                })
                const initial = await first.callGreeting('get-greeting', {})
                expect(initial.status).toBe(200)
                expect(await initial.json()).toStrictEqual({ greeting: defaultGreeting })
                const save = await first.callGreeting('save-greeting', { greeting })
                expect(save.status).toBe(200)
                expect(await save.json()).toStrictEqual({ greeting })
                const stored = await first.callGreeting('get-greeting', {})
                expect(stored.status).toBe(200)
                expect(await stored.json()).toStrictEqual({ greeting })
            } finally {
                await first.stop()
            }

            const restarted = await startDevRuntime({
                ...options,
                generation: 2,
                launcher: 'candidate',
            })
            try {
                expect(restarted.contextCalls()).toBe(1)
                const staleScope = { generation: 1 }
                const staleContext = await restarted.fetchCore(staleScope)
                expect(staleContext.status).toBe(403)
                expect(await staleContext.json()).toMatchObject({
                    status: 403,
                    code: 'installationContextRejected',
                })
                const staleWrite = await restarted.callGreeting(
                    'save-greeting',
                    { greeting: 'A stale installation tried to write' },
                    'stale-write',
                    staleScope,
                )
                expect(staleWrite.status).toBe(403)
                expect(await staleWrite.json()).toMatchObject({ code: 'scopeDenied', status: 403 })
                const persisted = await restarted.callGreeting('get-greeting', {})
                expect(persisted.status).toBe(200)
                expect(await persisted.json()).toStrictEqual({ greeting })
            } finally {
                await restarted.stop()
            }
        } finally {
            await rm(dataDirectory, { recursive: true, force: true })
        }
    },
    15_000,
)
