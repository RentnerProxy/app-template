export const maxJsonSize = 4096

export async function readJson(
    stream: ReadableStream<Uint8Array>,
    limit = maxJsonSize,
): Promise<unknown> {
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of stream) {
        size += chunk.byteLength
        if (size > limit) throw new Error('JSON exceeds the size limit')
        chunks.push(chunk)
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat(chunks, size),
    )
    return JSON.parse(text)
}

export function hasJsonContentType(headers: Headers): boolean {
    const [mediaType] = headers.get('Content-Type')?.split(';', 1) ?? []
    return mediaType?.trim().toLowerCase() === 'application/json'
}
