import { expect, test } from 'bun:test'

import openapi from '../../api/openapi.json'
import { readGreeting } from '../lib/greeting.ts'

const schema = openapi.components.schemas.Greeting.properties.greeting
const pattern = new RegExp(schema.pattern, 'u')

const cases: [string, string, boolean][] = [
    ['a single character', 'é', true],
    ['ordinary Unicode and internal spaces', 'Gude 👋   Grüße 世界', true],
    ['an internal nonbreaking space', 'Hello\u00a0world', true],
    ['120 ASCII characters', 'a'.repeat(120), true],
    ['121 ASCII characters', 'a'.repeat(121), false],
    ['120 emoji', '👋'.repeat(120), true],
    ['121 emoji', '👋'.repeat(121), false],
    ['an empty string', '', false],
    ['only whitespace', '   ', false],
    ['leading whitespace', ' Hello', false],
    ['trailing whitespace', 'Hello ', false],
    ['leading Unicode whitespace', '\u00a0Hello', false],
    ['trailing Unicode whitespace', 'Hello\u3000', false],
    ['a trailing newline', 'Hello\n', false],
    ['an ASCII control character', 'Hello\u0000world', false],
    ['a tab between words', 'Hello\tworld', false],
    ['a C1 control character', 'Hello\u0085world', false],
]

test.each(cases)('Greeting handler and schema agree for %s', (_label, greeting, accepted) => {
    const length = [...greeting].length
    const matchesSchema =
        length >= schema.minLength && length <= schema.maxLength && pattern.test(greeting)
    expect(matchesSchema).toBe(accepted)
    expect(readGreeting({ greeting })).toBe(accepted ? greeting : undefined)
})

test('Greeting handler rejects lone UTF-16 surrogates', () => {
    expect(readGreeting({ greeting: 'Hello\ud800world' })).toBeUndefined()
})
