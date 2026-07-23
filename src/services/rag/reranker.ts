import { env } from '../../config/constants'
import { log } from '../logger'
import type { HybridSearchResult } from './hybrid'

function getAuthHeaders(): Record<string, string> {
    const key = env.OPENROUTER_API_KEY
    if (!key) throw new Error('OPENROUTER_API_KEY is not set')
    return {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
    }
}

export async function rerankChunks(query: string, chunks: HybridSearchResult[], topK: number): Promise<HybridSearchResult[]> {
    if (chunks.length <= topK) return chunks

    const body = {
        model: 'cohere/rerank-4-pro',
        query,
        documents: chunks.map((c) => c.text),
        top_n: topK
    }

    const url = `${env.OPENROUTER_BASE_URL}/rerank`
    const t0 = performance.now()

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(body)
        })

        const duration = (performance.now() - t0).toFixed(0)

        if (!res.ok) {
            const text = await res.text()
            throw new Error(`Rerank API error ${res.status}: ${text.slice(0, 300)}`)
        }

        const data = (await res.json()) as {
            results?: { index: number; relevance_score: number }[]
        }

        if (!data.results || data.results.length === 0) {
            log.warn({ module: 'reranker', duration: `${duration}ms` }, 'Reranker returned empty results')
            return chunks.slice(0, topK)
        }

        data.results.sort((a, b) => b.relevance_score - a.relevance_score)

        log.info(
            {
                module: 'reranker',
                model: 'cohere/rerank-4-pro',
                from: chunks.length,
                to: data.results.length,
                topScore: data.results[0]?.relevance_score.toFixed(4),
                duration: `${duration}ms`
            },
            'Reranking completed'
        )

        return data.results.slice(0, topK).map((r) => {
            const idx = r.index
            if (idx < 0 || idx >= chunks.length) {
                throw new Error(`Reranker returned out-of-bounds index ${idx}`)
            }
            return { ...chunks[idx], score: r.relevance_score }
        })
    } catch (e) {
        log.error({ module: 'reranker', error: String(e) }, 'Reranking failed, falling back to score order')
        return chunks.slice(0, topK)
    }
}
