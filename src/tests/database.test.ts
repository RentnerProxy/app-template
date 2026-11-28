import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import app from '../../app.config.json'
import { dropDevDatabase, provisionDevDatabase } from '../../scripts/dev/database.ts'
import { openAppDatabase } from '../server/database.ts'

// A disposable PostgreSQL superuser URL, for example from the CI service container.
const adminUrl = process.env.APP_TEST_DATABASE_URL

async function withUrlFile(run: (path: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), 'greeting-database-'))
    try {
        await run(join(directory, 'database-url'))
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}

test('The database helper requires the platform URL file', async () => {
    await expect(openAppDatabase('')).rejects.toThrow('The platform provides no app database')
    await withUrlFile(async (path) => {
        await writeFile(path, 'sqlite://greeting.db\n')
        await expect(openAppDatabase(path)).rejects.toThrow('Invalid app database URL')
    })
})

test.skipIf(!adminUrl)(
    'Migrations run as the schema owner and the runtime role only changes rows',
    async () => {
        if (!adminUrl) return
        const name = 'test_' + randomBytes(6).toString('hex')
        try {
            await withUrlFile(async (path) => {
                await writeFile(path, (await provisionDevDatabase(adminUrl, name)) + '\n', {
                    mode: 0o400,
                })
                const database = await openAppDatabase(path)
                try {
                    const [saved] = await database`
                        INSERT INTO greeting_history (greeting) VALUES (${'Gude!'})
                        RETURNING greeting`
                    expect(saved).toStrictEqual({ greeting: 'Gude!' })
                    const [table] = await database`
                        SELECT tableowner FROM pg_tables
                        WHERE schemaname = 'app' AND tablename = 'greeting_history'`
                    expect(table).toStrictEqual({ tableowner: 'rp_migrate_' + name })
                    const [schema] = await database`
                        SELECT obj_description('app'::regnamespace, 'pg_namespace') AS marker`
                    expect(schema).toStrictEqual({
                        marker: 'rentnerproxy.data-version=' + app.data.targetVersion,
                    })
                    for (const statement of [
                        'CREATE TABLE app.forbidden (id bigint)',
                        'SET ROLE rp_migrate_' + name,
                    ]) {
                        await expect(database.unsafe(statement)).rejects.toMatchObject({
                            errno: '42501',
                        })
                    }
                } finally {
                    await database.close()
                }
                // A restart finds the recorded data version and runs no step twice.
                await provisionDevDatabase(adminUrl, name)
            })
        } finally {
            await dropDevDatabase(adminUrl, name)
        }
    },
    20_000,
)
