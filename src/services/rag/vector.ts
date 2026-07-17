import { db } from '../../db/client'
import { chunks } from '../../db/schema'
import { generateEmbedding } from '../llm/openrouter'
import { cosineDistance, desc, sql } from 'drizzle-orm'
import { env } from '../../config/constants'

export interface SearchResult {
    chunkId: bigint
    documentId: bigint
    text: string
    score: number
    metadata: Record<string, unknown> | null
}

export async function vectorSearch(query: string): Promise<SearchResult[]> {
    const embedding = await generateEmbedding(query)
    const vectorStr = `[${embedding.join(',')}]`

    const topK = env.RAG_TOP_K

    const results = await db.execute<{
        id: string
        document_id: string
        text: string
        score: string
        metadata: string
    }>(
        sql`
            SELECT
                c.id,
                c.document_id,
                c.text,
                1 - (c.embedding <=> ${vectorStr}::vector) AS score,
                c.metadata
            FROM ${chunks} c
            WHERE c.embedding IS NOT NULL
            ORDER BY c.embedding <=> ${vectorStr}::vector
            LIMIT ${topK}
        `
    )

    return results.map((r) => ({
        chunkId: BigInt(r.id),
        documentId: BigInt(r.document_id),
        text: r.text,
        score: Number.parseFloat(r.score),
        metadata: r.metadata ? JSON.parse(r.metadata as string) : null
    }))
}
