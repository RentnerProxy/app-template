import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { SQL } from 'bun'

import appConfig from '../../app.config.json'

const root = join(import.meta.dir, '../..')
const marker = 'rentnerproxy.data-version='

function roles(name: string) {
    if (!/^[a-z][a-z0-9_]{0,39}$/u.test(name)) throw new Error('Invalid app database name')
    return { runtime: 'rp_app_' + name, owner: 'rp_migrate_' + name }
}

/**
 * Derive a URL for another database or role. Bun reads the `user`, `password` and `dbname` query
 * parameters before the userinfo and path, so the replaced parts must not survive as parameters.
 * Other parameters, such as `sslmode`, stay.
 */
export function databaseUrl(adminUrl: string, database?: string, user?: string, password?: string) {
    const url = new URL(adminUrl)
    if (database) {
        url.pathname = '/' + database
        url.searchParams.delete('dbname')
        url.searchParams.delete('database')
    }
    if (user) {
        url.username = user
        url.searchParams.delete('user')
        url.searchParams.delete('username')
    }
    if (password) {
        url.password = password
        url.searchParams.delete('password')
    }
    return url.href
}

function connect(url: string) {
    return new SQL({ adapter: 'postgres', url, connectionTimeout: 5 })
}

/** Follow the declared steps from the recorded data version to the target, like the platform. */
function migrationSteps(recorded: number) {
    const { migrations, targetVersion } = appConfig.data
    const steps: string[] = []
    for (let version = recorded; version < targetVersion;) {
        const step = migrations.find(({ fromVersion }) => fromVersion === version)
        if (!step) throw new Error('No declared migration from data version ' + version)
        steps.push(step.path)
        version = step.toVersion
    }
    return steps
}

/**
 * Provision a disposable app database the way the platform does: a runtime role that may only
 * change rows in the `app` schema, a schema owner that runs the declared migration steps in one
 * transaction, and the reached data version as the schema comment. Needs a PostgreSQL superuser
 * URL. Returns the runtime role URL that the platform would write to the app's URL file.
 */
export async function provisionDevDatabase(adminUrl: string, name: string) {
    const { runtime, owner } = roles(name)
    const password = randomBytes(32).toString('hex')
    const runtimeUrl = databaseUrl(adminUrl, runtime, runtime, password)
    const admin = connect(adminUrl)
    try {
        await admin.unsafe(`DO $$ BEGIN
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${runtime}') THEN
                CREATE ROLE ${runtime};
            END IF;
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${owner}') THEN
                CREATE ROLE ${owner};
            END IF;
        END $$;
        ALTER ROLE ${runtime} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            CONNECTION LIMIT 4 PASSWORD '${password}';
        ALTER ROLE ${owner} WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;`)
        const [existing] = await admin`SELECT FROM pg_database WHERE datname = ${runtime}`
        if (!existing) await admin.unsafe(`CREATE DATABASE ${runtime}`)
        await admin.unsafe(`REVOKE ALL ON DATABASE ${runtime} FROM PUBLIC;
        GRANT CONNECT ON DATABASE ${runtime} TO ${runtime};
        ALTER ROLE ${runtime} IN DATABASE ${runtime} SET search_path TO app;`)
    } finally {
        await admin.close()
    }

    const database = connect(databaseUrl(adminUrl, runtime))
    try {
        await database.unsafe(`REVOKE ALL ON SCHEMA public FROM PUBLIC;
        CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION ${owner};
        REVOKE ALL ON SCHEMA app FROM PUBLIC;
        GRANT USAGE ON SCHEMA app TO ${runtime};
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO ${runtime};
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO ${runtime};
        ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA app
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime};
        ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA app
            GRANT USAGE, SELECT ON SEQUENCES TO ${runtime};`)
        const [schema] =
            await database`SELECT obj_description('app'::regnamespace, 'pg_namespace') AS comment`
        const comment: unknown = schema?.comment
        const recorded =
            typeof comment === 'string' && comment.startsWith(marker)
                ? Number(comment.slice(marker.length))
                : 0
        const steps = migrationSteps(recorded)
        if (steps.length > 0) {
            // The runtime role may assume the schema owner only while the steps run.
            await database.unsafe(
                `GRANT ${owner} TO ${runtime} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
            )
            const migration = connect(runtimeUrl)
            try {
                await migration.begin(async (transaction) => {
                    await transaction.unsafe(`SET ROLE ${owner}`)
                    for (const step of steps) {
                        await transaction.unsafe(await Bun.file(join(root, step)).text())
                    }
                    const version = appConfig.data.targetVersion
                    await transaction.unsafe(`COMMENT ON SCHEMA app IS '${marker}${version}'`)
                })
            } finally {
                await migration.close()
            }
        }
    } finally {
        try {
            // On every path, also after an interrupted earlier run: the runtime role must not keep
            // the schema owner membership.
            await database.unsafe(`REVOKE ${owner} FROM ${runtime}`)
        } finally {
            await database.close()
        }
    }
    return runtimeUrl
}

export async function dropDevDatabase(adminUrl: string, name: string) {
    const { runtime, owner } = roles(name)
    const admin = connect(adminUrl)
    try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${runtime} WITH (FORCE)`)
        await admin.unsafe(`DROP ROLE IF EXISTS ${runtime}; DROP ROLE IF EXISTS ${owner};`)
    } finally {
        await admin.close()
    }
}
