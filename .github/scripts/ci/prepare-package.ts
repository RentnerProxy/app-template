import { deepStrictEqual } from 'node:assert'
import { lstat, mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import app from '../../../app.config.json'
import { writePackageArchive } from '../../../scripts/archive.ts'

const [tree, archive, extracted] = Bun.argv.slice(2)
if (!tree || !archive || !extracted || ![tree, archive, extracted].every(isAbsolute)) {
    throw new Error('Expected absolute package tree, archive and extracted paths')
}

await writePackageArchive(tree, archive)
await mkdir(extracted)
const unpack = Bun.spawn(['tar', '--zstd', '-xf', archive, '-C', extracted], {
    stdout: 'inherit',
    stderr: 'inherit',
})
if ((await unpack.exited) !== 0) throw new Error('Could not extract the development package')

deepStrictEqual(await Bun.file(join(extracted, 'app.json')).json(), {
    ...app,
    target: process.env.APP_TARGET,
    source: {
        repositoryId: process.env.APP_SOURCE_REPOSITORY_ID,
        commit: process.env.APP_SOURCE_COMMIT,
    },
})

for (const [name, mode] of [
    ['LICENSE', 0o644],
    ['app.json', 0o644],
    [app.api, 0o644],
    [app.entrypoint, 0o755],
    [app.ui.entrypoint, 0o644],
    ['ui/app.css', 0o644],
    ['ui/app.js', 0o644],
    ...app.data.migrations.map(({ path }) => [path, 0o644] as const),
] as const) {
    const file = await lstat(join(extracted, name))
    if (!file.isFile() || file.size === 0 || (file.mode & 0o777) !== mode) {
        throw new Error('Invalid packaged file: ' + name)
    }
}
