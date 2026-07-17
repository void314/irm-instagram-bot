export interface Chunk {
    content: string
    index: number
}

const CHARS_PER_TOKEN = 4
const MAX_CHARS = 500 * CHARS_PER_TOKEN
const OVERLAP_CHARS = 100 * CHARS_PER_TOKEN

export function chunkText(text: string): Chunk[] {
    const paragraphs = text.split(/\n\s*\n/).filter(Boolean)
    if (paragraphs.length === 0) return []

    const chunks: Chunk[] = []
    let buffer = ''
    let index = 0

    for (const para of paragraphs) {
        if (buffer.length + para.length > MAX_CHARS && buffer.length > 0) {
            chunks.push({ content: buffer.trim(), index: index++ })
            buffer = getOverlap(buffer)
        }
        buffer += (buffer.length > 0 ? '\n\n' : '') + para
    }

    if (buffer.trim()) {
        chunks.push({ content: buffer.trim(), index })
    }

    return chunks
}

function getOverlap(text: string): string {
    if (text.length <= OVERLAP_CHARS) return text + '\n\n'
    return text.slice(-OVERLAP_CHARS) + '\n\n'
}
