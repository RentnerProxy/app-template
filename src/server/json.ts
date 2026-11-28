export const maxJsonSize = 4096

/** A JSON document is larger than allowed. Reading it again cannot succeed. */
export class JsonSizeError extends Error {
    constructor() {
        super('JSON exceeds the size limit')
        this.name = 'JsonSizeError'
    }
}

/** Read a body up to `limit` bytes. Only the transport can fail here, besides the size limit. */
export async function readBytes(
    stream: ReadableStream<Uint8Array>,
    limit = maxJsonSize,
): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of stream) {
        size += chunk.byteLength
        if (size > limit) throw new JsonSizeError()
        chunks.push(chunk)
    }
    return Buffer.concat(chunks, size)
}

export function parseJsonBytes(bytes: Uint8Array): unknown {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
}

export async function readJson(
    stream: ReadableStream<Uint8Array>,
    limit = maxJsonSize,
): Promise<unknown> {
    return parseJsonBytes(await readBytes(stream, limit))
}

export function hasJsonContentType(headers: Headers): boolean {
    const [mediaType] = headers.get('Content-Type')?.split(';', 1) ?? []
    return mediaType?.trim().toLowerCase() === 'application/json'
}
