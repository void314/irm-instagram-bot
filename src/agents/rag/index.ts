import { env } from '../../config/constants'
import { type ChatMessage, generateEmbedding } from '../../services/llm/openrouter'
import { log } from '../../services/logger'
import { checkGrounding } from '../../services/rag/grounding'
import { type HybridSearchResult, hybridSearch } from '../../services/rag/hybrid'
import { resolveSearchQueries } from '../../services/rag/query-rewrite'
import { rerankChunks } from '../../services/rag/reranker'
import { type RagDebug } from '../orchestrator'
import type { AgentResult } from '../types'

export async function processRagQuery(query: string, history: ChatMessage[], debug: RagDebug): Promise<AgentResult> {
    const { queries: searchQueries, semanticQuery } = await resolveSearchQueries(query, history)
    if (searchQueries.length > 1) {
        log.info({ module: 'agent:rag', original: query, expanded: searchQueries.slice(1) }, 'Query expansion')
    }

    const emb = await generateEmbedding(semanticQuery)

    const allResults = await Promise.all(searchQueries.map((q) => hybridSearch(q, q.toLowerCase() === semanticQuery.toLowerCase() ? emb : undefined)))
    const initialResults = allResults
        .flat()
        .sort((a, b) => b.score - a.score)
        .slice(0, env.RAG_TOP_K)

    let searchResults: HybridSearchResult[]
    if (initialResults.length > env.RAG_RERANK_TOP_K) {
        searchResults = await rerankChunks(query, initialResults, env.RAG_RERANK_TOP_K)
    } else {
        searchResults = initialResults
        log.debug(
            {
                module: 'agent:rag',
                reranker: 'skipped',
                reason: `initial_results=${initialResults.length} <= RAG_RERANK_TOP_K=${env.RAG_RERANK_TOP_K}`
            },
            'Reranker skipped — too few results'
        )
    }

    debug.searchResultsCount = searchResults.length
    log.info(
        {
            module: 'agent:rag',
            queries: searchQueries.length,
            initial: initialResults.length,
            final: searchResults.length
        },
        'Hybrid search results'
    )

    if (searchResults.length === 0) {
        return { content: '', confidence: 'low', gaps: [] }
    }

    const allScores = searchResults.map((r) => r.score)
    debug.allScores = allScores
    debug.topScore = Math.max(...allScores)
    debug.topChunkSnippet = searchResults[0].text.slice(0, 120).replace(/\n/g, ' ')

    const { passed } = checkGrounding(searchResults)
    debug.groundingPassed = passed

    const contextStr = searchResults.map((r) => `[релевантность: ${(r.score * 100).toFixed(0)}%]\n${r.text}`).join('\n\n---\n\n')

    return {
        content: contextStr,
        confidence: passed ? 'high' : 'low',
        gaps: []
    }
}
