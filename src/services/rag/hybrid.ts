import { db } from '../../db/client'
import { generateEmbedding } from '../llm/openrouter'
import { sql } from 'drizzle-orm'
import { env } from '../../config/constants'

export interface HybridSearchResult {
    chunkId: bigint
    documentId: bigint
    text: string
    vectorScore: number
    bm25Score: number
    score: number
    metadata: Record<string, unknown> | null
}

export async function hybridSearch(query: string): Promise<HybridSearchResult[]> {
    const embedding = await generateEmbedding(query)
    const vectorLiteral = sql.raw(`'[${embedding.join(',')}]'::vector`)
    const topK = env.RAG_TOP_K
    const alpha = 0.5

    const results = await db.execute<{
        id: string
        document_id: string
        text: string
        vector_score: string
        bm25_score: string
        score: string
        metadata: string
    }>(
        sql`
            WITH scored AS (
                SELECT
                    c.id,
                    c.document_id,
                    c.text,
                    1 - (c.embedding <=> ${vectorLiteral}) AS vector_score,
                    COALESCE(ts_rank(c.tsv, plainto_tsquery('russian', ${query})), 0) AS bm25_score,
                    c.metadata
                FROM chunks c
                WHERE c.embedding IS NOT NULL
            )
            SELECT
                id,
                document_id,
                text,
                vector_score,
                bm25_score,
                (${alpha} * vector_score + ${1 - alpha} * bm25_score) AS score,
                metadata
            FROM scored
            WHERE vector_score > 0.1 OR bm25_score > 0.01
            ORDER BY score DESC
            LIMIT ${topK}
        `
    )

    return results.map((r) => ({
        chunkId: BigInt(r.id),
        documentId: BigInt(r.document_id),
        text: r.text,
        vectorScore: Number.parseFloat(r.vector_score),
        bm25Score: Number.parseFloat(r.bm25_score),
        score: Number.parseFloat(r.score),
        metadata: r.metadata ? JSON.parse(r.metadata as string) : null
    }))
}
