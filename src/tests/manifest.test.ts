import { expect, test } from 'bun:test'
import { join } from 'node:path'

import { parseAppManifest } from '@rentnerproxy/app-contracts'

import openapi from '../../api/openapi.json'
import app from '../../app.config.json'

const root = join(import.meta.dir, '../..')

test('app.config.json satisfies the published manifest contract', () => {
    const source = { repositoryId: '1', commit: '0'.repeat(40) }
    for (const target of ['linux-amd64', 'linux-arm64'] as const) {
        expect(() => parseAppManifest({ ...app, target, source })).not.toThrow()
    }
})

test('Every declared migration step is a SQL file under migrations/', async () => {
    for (const { path } of app.data.migrations) {
        expect(path).toMatch(/^migrations\/.+\.sql$/u)
        expect(await Bun.file(join(root, path)).exists()).toBe(true)
    }
})

test('The native presentation uses declared routes, dialogs, operations and limits', () => {
    const ui = openapi['x-rentnerproxy-ui']
    const { pages } = openapi['x-rentnerproxy-native-ui']
    const operations = Object.values(openapi.paths).map(({ post }) => post.operationId)
    const { minLength, maxLength } = openapi.components.schemas.Greeting.properties.greeting
    expect(pages.map(({ route }) => route).toSorted()).toStrictEqual(ui.routes.toSorted())
    for (const { kind, read, write, confirm, fields } of pages) {
        expect(operations).toContain(read)
        if (kind !== 'form') continue
        expect(operations).toContain(String(write))
        expect(ui.dialogs).toContain(String(confirm))
        expect(fields).toBeArray()
        for (const field of fields ?? []) expect(field).toMatchObject({ minLength, maxLength })
    }
})
