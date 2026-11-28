import { equal } from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { chromium, expect, type Request } from '@playwright/test'

import { startDevHost } from '../../../scripts/dev/host.ts'
import { defaultGreeting } from '../../../src/lib/greeting.ts'

const [packageDirectory] = Bun.argv.slice(2)
if (!packageDirectory || !isAbsolute(packageDirectory)) {
    throw new Error('Expected the absolute extracted package directory')
}

function isGreetingRead(request: Request) {
    return (
        new URL(request.url()).pathname === '/dev/v1/greeting' &&
        request.postData()?.includes('"operationId":"get-greeting"') === true
    )
}

const dataDirectory = await mkdtemp(join(tmpdir(), 'greeting-browser-'))
try {
    const host = await startDevHost({
        uiDirectory: join(packageDirectory, 'ui'),
        executable: join(packageDirectory, 'bin/app'),
        dataDirectory,
    })
    try {
        const browser = await chromium.launch({ timeout: 10_000 })
        try {
            const page = await browser.newPage({ serviceWorkers: 'block' })
            page.setDefaultTimeout(8_000)
            const external: string[] = []
            const errors: string[] = []
            page.on('pageerror', (error) => errors.push(error.message))
            await page.route('**/*', (route) => {
                const url = new URL(route.request().url())
                if (url.origin === host.url.origin) return route.continue()
                external.push(url.origin)
                return route.abort()
            })
            await page.goto(host.url.href, { timeout: 10_000 })
            const frame = page.frameLocator('#greeting-app')
            await expect(page.locator('#greeting-app')).toHaveAttribute('sandbox', 'allow-scripts')
            await expect(frame.getByRole('heading', { name: 'Greeting' })).toBeVisible()
            await expect(frame.getByRole('textbox', { name: 'New greeting' })).toHaveValue(
                defaultGreeting,
            )
            equal(await frame.locator('html').evaluate(() => globalThis.origin), 'null')
            const src = await page.locator('#greeting-app').getAttribute('src')
            if (!src) throw new Error('The installed app document is missing')
            equal((await page.request.get(new URL(src, host.url).href)).status(), 403)

            await page.selectOption('#theme', 'dark')
            // The document language follows the copy the app renders, not the host locale.
            await page.selectOption('#locale', 'fr-FR')
            await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark')
            await expect(frame.locator('html')).toHaveAttribute('lang', 'en')
            await page.selectOption('#locale', 'de')
            await expect(frame.locator('html')).toHaveAttribute('lang', 'de')
            await frame.getByRole('button', { name: 'Details' }).click()
            await expect(
                frame.getByText('Dein Gruß wird in dieser App-Installation gespeichert.'),
            ).toBeVisible()
            await frame.getByRole('button', { name: 'Übersicht' }).click()

            const input = frame.getByRole('textbox', { name: 'Neuer Gruß' })
            const save = frame.getByRole('button', { name: 'Gruß speichern' })
            const greeting = 'Gude vom installierten Paket!'
            const unicodeLimit = '🙂'.repeat(120)
            await input.fill(unicodeLimit)
            await expect(input).toHaveValue(unicodeLimit)
            await input.fill(greeting)
            await save.click()
            await page.getByRole('button', { name: 'Cancel' }).click()
            await expect(save).toBeEnabled()
            await expect(frame.getByText(defaultGreeting, { exact: true })).toBeVisible()

            const releaseRead = Promise.withResolvers<void>()
            let holdRead = true
            await page.route('**/dev/v1/greeting', async (route) => {
                if (!holdRead || !isGreetingRead(route.request())) return route.fallback()
                holdRead = false
                await releaseRead.promise
                await route.fulfill({ json: { greeting: defaultGreeting } })
            })
            try {
                const ready = page.getByRole('checkbox', { name: 'App ready' })
                await ready.uncheck()
                await expect(input).toBeDisabled()
                await Promise.all([page.waitForRequest(isGreetingRead), ready.check()])
                await input.press('Enter')
                await page.getByRole('button', { name: 'Confirm' }).click()
                await expect(frame.getByText(greeting, { exact: true })).toBeVisible()
                await expect(frame.getByText('Gruß gespeichert', { exact: true })).toBeVisible()
                const readResponse = page.waitForResponse((response) =>
                    isGreetingRead(response.request()),
                )
                releaseRead.resolve()
                await readResponse
                await frame.locator('html').evaluate(
                    () =>
                        new Promise<void>((resolve) => {
                            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
                        }),
                )
                await expect(input).toHaveValue(greeting)
            } finally {
                releaseRead.resolve()
            }

            await page.getByRole('button', { name: 'Replace app' }).click()
            await expect(page.locator('body')).toHaveAttribute('data-generation', '2')
            // The new document starts light and English, so only a handshake applies the context.
            await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark')
            await expect(frame.locator('html')).toHaveAttribute('lang', 'de')
            await expect(input).toHaveValue(greeting)

            // A page kept for Back and Forward keeps its bridge, which still delivers context.
            await page.evaluate(() => {
                dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
                dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
            })
            await page.selectOption('#theme', 'light')
            await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light')

            // A frame that never announces itself is not closed silently: the host offers a reload.
            let blockScript = true
            await page.route('**/app.js', (route) =>
                blockScript ? route.abort() : route.fallback(),
            )
            await page.getByRole('button', { name: 'Replace app' }).click()
            const failure = page.locator('#bridge-failed')
            await expect(failure).toBeVisible({ timeout: 9_000 })
            await expect(page.locator('#greeting-app')).toHaveCount(0)
            blockScript = false
            await failure.getByRole('button', { name: 'Reload app' }).click()
            await expect(failure).toBeHidden()
            await expect(page.locator('body')).toHaveAttribute('data-generation', '4')
            await expect(frame.getByRole('heading', { name: 'Greeting' })).toBeVisible()
            await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light')
            equal(external.length, 0, 'The packaged UI made an external request')
            equal(errors.length, 0, errors.join('\n'))
            console.log('Packaged Greeting passed the sandboxed browser smoke')
        } finally {
            await browser.close()
        }
    } finally {
        await host.stop()
    }
} finally {
    await rm(dataDirectory, { recursive: true, force: true })
}
