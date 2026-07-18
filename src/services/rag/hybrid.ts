import { sql } from 'drizzle-orm'

import { env } from '../../config/constants'
import { db } from '../../db/client'

export interface HybridSearchResult {
    chunkId: bigint
    documentId: bigint
    text: string
    vectorScore: number
    bm25Score: number
    score: number
    metadata: Record<string, unknown> | null
}

export async function hybridSearch(query: string, embedding?: number[]): Promise<HybridSearchResult[]> {
    const topK = env.RAG_TOP_K

    const vectorColumn = embedding
        ? sql`, 1 - (c.embedding <=> ${sql.raw(`'[${embedding.join(',')}]'::vector`)}) AS vector_score`
        : sql`, 0 AS vector_score`

    const scoreExpr = embedding ? sql`(0.5 * vector_score + 0.5 * bm25_score) AS score` : sql`bm25_score AS score`

    const vectorFilter = embedding ? sql`OR vector_score > 0.1` : sql``

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
                    c.text
                    ${vectorColumn},
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
                ${scoreExpr},
                metadata
            FROM scored
            WHERE bm25_score > 0.01 ${vectorFilter}
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
