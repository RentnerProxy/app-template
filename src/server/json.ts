export const maxJsonSize = 4096

export async function readJson(stream: ReadableStream<Uint8Array>): Promise<unknown> {
    const buffer = new Uint8Array(maxJsonSize)
    let size = 0
    for await (const chunk of stream) {
        if (size + chunk.byteLength > buffer.length) throw new Error('JSON exceeds the size limit')
        buffer.set(chunk, size)
        size += chunk.byteLength
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, size),
    )
    return JSON.parse(text)
}

export function hasJsonContentType(headers: Headers): boolean {
    const [mediaType] = headers.get('Content-Type')?.split(';', 1) ?? []
    return mediaType?.trim().toLowerCase() === 'application/json'
}
