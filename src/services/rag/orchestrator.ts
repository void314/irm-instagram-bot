import { chat } from '../llm/openrouter'
import { log } from '../logger'
import { detectFastIntent } from './intent'
import { detectLanguage } from './language'
import { hybridSearch } from './hybrid'
import { checkGrounding } from './grounding'
import { getConversationContext, incrementMessageCount } from './context'
import { SYSTEM_PROMPT_NO_CONTEXT, SYSTEM_PROMPT_WITH_CONTEXT } from './prompts'

export interface RagContext {
    conversationId: bigint
}

export interface RagDebug {
    intentType: string
    historyLength: number
    searchResultsCount: number
    topScore: number
    topChunkSnippet: string
    allScores: number[]
    groundingPassed: boolean
}

export interface RagResponse {
    answer: string
    contextChunks: { text: string; score: number }[]
    intent: string
    needsClarification: boolean
    debug?: RagDebug
}

function ragLog(message: string, data?: Record<string, unknown>) {
    if (data) {
        log.info({ module: 'rag', ...data }, message)
        return
    }
    log.info({ module: 'rag' }, message)
}

export async function runPipeline(
    query: string,
    context?: RagContext,
    verbose = false
): Promise<RagResponse> {
    const debug: RagDebug = {
        intentType: 'query',
        historyLength: 0,
        searchResultsCount: 0,
        topScore: 0,
        topChunkSnippet: '',
        allScores: [],
        groundingPassed: true
    }

    const detectedLang = detectLanguage(query)
    ragLog('language detected', { language: detectedLang })

    const fastIntent = detectFastIntent(query, detectedLang)
    debug.intentType = fastIntent?.type ?? 'query'
    ragLog('intent detected', { intent: debug.intentType, question: query.slice(0, 60) })

    if (fastIntent && fastIntent.type !== 'query') {
        if (context && fastIntent.type === 'clear_context') {
            const { conversations } = await import('../../db/schema')
            const { db } = await import('../../db/client')
            const { eq } = await import('drizzle-orm')
            await db
                .update(conversations)
                .set({ summary: null })
                .where(eq(conversations.id, context.conversationId))
        }
        ragLog('fast response', { length: fastIntent.response!.length })
        const res: RagResponse = {
            answer: fastIntent.response!,
            contextChunks: [],
            intent: fastIntent.type,
            needsClarification: false
        }
        if (verbose) res.debug = debug
        return res
    }

    let history = ''
    if (context) {
        const ctx = await getConversationContext(context.conversationId)
        debug.historyLength = ctx.history.length
        ragLog('context loaded', {
            conversationId: context.conversationId.toString(),
            messageCount: ctx.messageCount,
            historyLength: debug.historyLength
        })
        if (ctx.history) history = ctx.history
    }

    ragLog('hybrid search: embedding query')
    const searchResults = await hybridSearch(query)
    debug.searchResultsCount = searchResults.length
    ragLog('hybrid search: results', { count: searchResults.length })

    if (searchResults.length === 0) {
        const systemMsg = SYSTEM_PROMPT_NO_CONTEXT.replace('{history}', history || 'нет')
        ragLog('LLM: no context')
        const answer = await chat([
            { role: 'system', content: systemMsg },
            { role: 'user', content: query }
        ])
        ragLog('LLM: response', { length: answer.length })
        if (context) await incrementMessageCount(context.conversationId)

        const res: RagResponse = { answer, contextChunks: [], intent: 'query', needsClarification: false }
        if (verbose) res.debug = debug
        return res
    }

    const allScores = searchResults.map((r) => r.score)
    debug.allScores = allScores
    debug.topScore = Math.max(...allScores)
    debug.topChunkSnippet = searchResults[0].text.slice(0, 120).replace(/\n/g, ' ')
    ragLog('top chunk', {
        topScore: Number(debug.topScore.toFixed(3)),
        snippet: debug.topChunkSnippet
    })

    const contextStr = searchResults
        .map((r) => `[релевантность: ${(r.score * 100).toFixed(0)}%]\n${r.text}`)
        .join('\n\n---\n\n')

    const systemPrompt = SYSTEM_PROMPT_WITH_CONTEXT
        .replace('{context}', contextStr)
        .replace('{history}', history || 'нет')

    ragLog('LLM: with context')
    const answer = await chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query }
    ])
    ragLog('LLM: response', { length: answer.length })

    ragLog('grounding', { maxScore: Number(debug.topScore.toFixed(3)) })
    const grounding = await checkGrounding(answer, searchResults, query)
    debug.groundingPassed = grounding.passed
    ragLog('grounding result', { passed: grounding.passed })

    if (grounding.needsClarification && grounding.clarificationQuestion) {
        ragLog('clarification', { reason: 'grounding' })
        if (context) await incrementMessageCount(context.conversationId)
        const res: RagResponse = {
            answer: grounding.clarificationQuestion,
            contextChunks: searchResults.map((r) => ({ text: r.text, score: r.score })),
            intent: 'query',
            needsClarification: true
        }
        if (verbose) res.debug = debug
        return res
    }

    if (context) await incrementMessageCount(context.conversationId)

    const res: RagResponse = {
        answer,
        contextChunks: searchResults.map((r) => ({ text: r.text, score: r.score })),
        intent: 'query',
        needsClarification: false
    }
    if (verbose) res.debug = debug
    return res
}
