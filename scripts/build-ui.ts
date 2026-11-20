import tailwind from 'bun-plugin-tailwind'
import { copyFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const source = resolve(import.meta.dir, '../src/features/Greeting')

export async function buildUi(directory: string) {
    await mkdir(directory, { recursive: true })
    const result = await Bun.build({
        entrypoints: [join(source, 'app.tsx'), join(source, 'app.css')],
        outdir: directory,
        format: 'iife',
        target: 'browser',
        plugins: [tailwind],
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        minify: true,
    })
    if (!result.success) throw new AggregateError(result.logs, 'Greeting UI build failed')
    await copyFile(join(source, 'index.html'), join(directory, 'index.html'))
}
