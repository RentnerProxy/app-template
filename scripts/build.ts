import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import app from '../app.config.json'
import { writePackageArchive } from './archive.ts'
import { buildUi } from './build-ui.ts'

const root = resolve(import.meta.dir, '..')

function getNativeTarget() {
    if (process.platform === 'linux') {
        if (process.arch === 'x64') return 'linux-amd64'
        if (process.arch === 'arm64') return 'linux-arm64'
    }
    throw new Error('Package compilation requires native AMD64 or ARM64 Linux')
}

async function buildPackage(
    directory: string,
    target: ReturnType<typeof getNativeTarget>,
    source: { repositoryId: string; commit: string },
) {
    await mkdir(directory, { recursive: true })
    if (!(await lstat(directory)).isDirectory() || (await readdir(directory)).length !== 0) {
        throw new Error('Package output must be an empty directory')
    }

    const executable = join(directory, 'bin/app')
    await mkdir(join(directory, 'bin'))
    // Bun stages a copy of its executable, which exceeds the candidate sandbox's /tmp budget.
    const scratch = await mkdtemp(join(directory, '.bun-compile-'))
    try {
        const compiler = Bun.spawn(
            [
                process.execPath,
                '--no-env-file',
                'build',
                '--compile',
                '--no-compile-autoload-dotenv',
                '--no-compile-autoload-bunfig',
                './src/server/index.ts',
                '--outfile',
                executable,
            ],
            {
                cwd: root,
                env: { ...process.env, TMPDIR: scratch },
                stdout: 'inherit',
                stderr: 'inherit',
            },
        )
        if ((await compiler.exited) !== 0) throw new Error('Greeting backend compilation failed')
    } finally {
        await rm(scratch, { recursive: true, force: true })
    }
    await chmod(executable, 0o755)
    await buildUi(join(directory, 'ui'))
    await mkdir(join(directory, 'api'))
    await copyFile(join(root, 'api/openapi.json'), join(directory, app.api))
    await copyFile(join(root, 'LICENSE'), join(directory, 'LICENSE'))
    await Bun.write(join(directory, 'app.json'), JSON.stringify({ ...app, target, source }) + '\n')
}

const nativeTarget = getNativeTarget()
const {
    APP_PACKAGE_DIR: packageDirectory,
    APP_TARGET: target,
    APP_SOURCE_REPOSITORY_ID: repositoryId,
    APP_SOURCE_COMMIT: commit,
} = process.env

if ([packageDirectory, target, repositoryId, commit].some((value) => value !== undefined)) {
    if (
        !packageDirectory ||
        !isAbsolute(packageDirectory) ||
        target !== nativeTarget ||
        !repositoryId ||
        !/^[1-9][0-9]{0,19}$/u.test(repositoryId) ||
        !commit ||
        !/^[a-f0-9]{40}$/u.test(commit)
    ) {
        throw new Error(
            'Expected an absolute APP_PACKAGE_DIR, native APP_TARGET and source ID/commit',
        )
    }
    await buildPackage(packageDirectory, nativeTarget, { repositoryId, commit })
} else {
    const output = join(root, 'dist')
    await mkdir(output, { recursive: true })
    const work = await mkdtemp(join(output, '.package-build-'))
    const directory = join(work, 'package')
    const archive = join(output, `${app.id}-${app.version}-${nativeTarget}-dev.tar.zst`)
    try {
        await buildPackage(directory, nativeTarget, { repositoryId: '1', commit: '0'.repeat(40) })
        await writePackageArchive(directory, archive)
        console.log(`Built local development package ${archive}`)
    } finally {
        await rm(work, { recursive: true, force: true })
    }
}
