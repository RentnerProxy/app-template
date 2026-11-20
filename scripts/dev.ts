import { join } from 'node:path'

import { buildUi } from './build-ui.ts'
import { startDevHost } from './dev/host.ts'

const root = join(import.meta.dir, '..')
const uiDirectory = join(root, 'dist/dev-ui')
const stopped = Promise.withResolvers<void>()
const stop = () => stopped.resolve()
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
    await buildUi(uiDirectory)
    const host = await startDevHost({ uiDirectory, dataDirectory: join(root, '.app-dev/data') })
    try {
        console.log('Local Platform stub running at ' + host.url.href)
        const code = await Promise.race([host.exited, stopped.promise])
        if (code !== undefined) throw new Error('Greeting app stopped with exit code ' + code)
    } finally {
        await host.stop()
    }
} finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
}
