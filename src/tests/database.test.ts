import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SQL } from 'bun'

import app from '../../app.config.json'
import { databaseUrl, dropDevDatabase, provisionDevDatabase } from '../../scripts/dev/database.ts'
import { openAppDatabase } from '../server/database.ts'
import { queryAdminUrl } from './support/database.ts'

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

test('Derived database URLs drop the identity parameters they replace', () => {
    const derived = new URL(
        databaseUrl(
            'postgres://admin:secret@db.example:5432/postgres?user=postgres&password=secret&dbname=postgres&sslmode=require',
            'rp_app_x',
            'rp_app_x',
            'runtime-password',
        ),
    )
    expect(derived.pathname).toBe('/rp_app_x')
    expect(derived.username).toBe('rp_app_x')
    expect(derived.password).toBe('runtime-password')
    expect([...derived.searchParams]).toStrictEqual([['sslmode', 'require']])
})

test('The admin URL keeps the identity parameters it already has', () => {
    const identity = (url: string) => {
        const { searchParams } = new URL(queryAdminUrl(url))
        return [searchParams.get('user'), searchParams.get('dbname')]
    }
    expect(identity('postgres://admin@db.example/main')).toStrictEqual(['admin', 'main'])
    expect(identity('postgres://db.example')).toStrictEqual(['postgres', 'postgres'])
    expect(identity('postgres://db.example/?user=ci_admin&dbname=ci_main')).toStrictEqual([
        'ci_admin',
        'ci_main',
    ])
    expect(identity('postgres://admin@db.example/main?user=ci_admin')).toStrictEqual([
        'ci_admin',
        'main',
    ])
})

test.skipIf(!adminUrl)(
    'Migrations run as the schema owner and the runtime role only changes rows',
    async () => {
        if (!adminUrl) return
        const name = 'test_' + randomBytes(6).toString('hex')
        try {
            await withUrlFile(async (path) => {
                await writeFile(
                    path,
                    (await provisionDevDatabase(queryAdminUrl(adminUrl), name)) + '\n',
                    {
                        mode: 0o400,
                    },
                )
                const database = await openAppDatabase(path)
                try {
                    const [identity] = await database`
                        SELECT current_user AS role, current_database() AS database`
                    expect(identity).toStrictEqual({
                        role: 'rp_app_' + name,
                        database: 'rp_app_' + name,
                    })
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
                // A run interrupted after its migration left the owner membership behind. A
                // restart finds the recorded data version, runs no step and still removes it.
                const admin = new SQL({ adapter: 'postgres', url: adminUrl })
                const membership = () =>
                    admin`SELECT pg_has_role(${'rp_app_' + name}, ${'rp_migrate_' + name}, 'MEMBER') AS member`
                try {
                    await admin.unsafe(`GRANT rp_migrate_${name} TO rp_app_${name}`)
                    expect(await membership()).toStrictEqual([{ member: true }])
                    await provisionDevDatabase(adminUrl, name)
                    expect(await membership()).toStrictEqual([{ member: false }])
                } finally {
                    await admin.close()
                }
            })
        } finally {
            await dropDevDatabase(adminUrl, name)
        }
    },
    20_000,
)
