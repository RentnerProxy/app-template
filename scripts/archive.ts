import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function writePackageArchive(directory: string, archive: string) {
    const parent = dirname(archive)
    await mkdir(parent, { recursive: true })
    const work = await mkdtemp(join(parent, '.package-'))
    const partial = join(work, 'package.tar.zst')

    try {
        const tar = Bun.spawn(
            [
                'tar',
                '--format=ustar',
                '--sort=name',
                '--mtime=@0',
                '--numeric-owner',
                '--owner=0',
                '--group=0',
                '--mode=u=rwX,go=rX',
                '-C',
                directory,
                '-cf',
                '-',
                '.',
            ],
            { stdout: 'pipe', stderr: 'inherit' },
        )
        try {
            const zstd = Bun.spawn(['zstd', '-q', '-T1', '--check', '-o', partial], {
                stdin: tar.stdout,
                stdout: 'ignore',
                stderr: 'inherit',
            })
            const [tarExit, compressionExit] = await Promise.all([tar.exited, zstd.exited])
            if (tarExit !== 0 || compressionExit !== 0) throw new Error('Package archiving failed')
        } finally {
            if (tar.exitCode === null) tar.kill()
            await tar.exited
        }
        await rename(partial, archive)
    } finally {
        await rm(work, { recursive: true, force: true })
    }
}
