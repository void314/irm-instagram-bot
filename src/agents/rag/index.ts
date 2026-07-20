import { env } from '../../config/constants'
import { isLearningEnabled } from '../../config/learning'
import { type ChatMessage, type ToolCall, chat, generateEmbedding } from '../../services/llm/openrouter'
import { log } from '../../services/logger'
import { type GroundingResult, checkGrounding } from '../../services/rag/grounding'
import { hybridSearch } from '../../services/rag/hybrid'
import { findPendingOverrides } from '../../services/rag/override'
import { type PatientInfo } from '../../services/rag/patient'
import { SYSTEM_PROMPT_NO_CONTEXT, SYSTEM_PROMPT_WITH_CONTEXT } from '../../services/rag/prompts'
import { resolveSearchQueries } from '../../services/rag/query-rewrite'
import { executeTool, getToolDefinitions } from '../../services/tools'
import { type RagDebug } from '../orchestrator'
import type { AgentResult } from '../types'

// We'll move it or just use it from there

const SYNTHETIC_BOOSTS = new Set(['прайс услуги', 'список услуг клиники'])

function pickSemanticQuery(originalQuery: string, searchQueries: string[]): string {
    for (let i = searchQueries.length - 1; i >= 0; i--) {
        const q = searchQueries[i]?.trim().toLowerCase()
        if (!q) continue
        if (!SYNTHETIC_BOOSTS.has(q)) return searchQueries[i]
    }
    return originalQuery
}

export function parseHistory(historyStr: string): { role: 'user' | 'assistant'; content: string }[] {
    if (!historyStr || historyStr === 'нет') return []
    return historyStr
        .split('\n')
        .map((line) => {
            const colonIndex = line.indexOf(': ')
            if (colonIndex === -1) return null
            const role = line.slice(0, colonIndex).trim()
            const content = line.slice(colonIndex + 2).trim()
            if (role !== 'user' && role !== 'assistant') return null
            return { role: role as 'user' | 'assistant', content }
        })
        .filter(Boolean) as { role: 'user' | 'assistant'; content: string }[]
}

function formatToday(): string {
    const now = new Date()
    return now.toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        weekday: 'long'
    })
}

function injectPrompt(template: string, replacements: Record<string, string>): string {
    let result = template
    for (const [key, value] of Object.entries(replacements)) {
        result = result.replace(`{${key}}`, value)
    }
    return result
}

export async function processRagQuery(
    query: string,
    history: string,
    patientStr: string,
    patient: PatientInfo | null,
    debug: RagDebug
): Promise<AgentResult> {
    const parsedHistory = parseHistory(history)
    const searchQueries = await resolveSearchQueries(query, parsedHistory)
    if (searchQueries.length > 1) {
        log.info({ module: 'agent:rag', original: query, expanded: searchQueries.slice(1) }, 'Query expansion')
    }

    const semanticQuery = pickSemanticQuery(query, searchQueries)
    const emb = await generateEmbedding(semanticQuery)

    const allResults = await Promise.all(
        searchQueries.map((q) =>
            hybridSearch(q, q.toLowerCase() === semanticQuery.toLowerCase() ? emb : undefined)
        )
    )
    const searchResults = allResults
        .flat()
        .sort((a, b) => b.score - a.score)
        .slice(0, env.RAG_TOP_K)

    debug.searchResultsCount = searchResults.length
    log.info(
        { module: 'agent:rag', queries: searchQueries.length, total: searchResults.length },
        'Hybrid search results'
    )

    const tools = getToolDefinitions()
    const baseReplacements: Record<string, string> = {
        history: history || 'нет',
        patientContext: patientStr || '',
        today: formatToday()
    }

    async function callLlm(systemPrompt: string): Promise<{ content: string; toolCalls?: ToolCall[] }> {
        return chat(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: query }
            ],
            { tools, tool_choice: 'auto', model: 'deepseek/deepseek-v4-flash' }
        )
    }

    async function callLlmWithTools(systemPrompt: string): Promise<{ content: string; usedTools: boolean }> {
        const first = await callLlm(systemPrompt)

        if (first.toolCalls && first.toolCalls.length > 0) {
            log.info({ module: 'agent:rag', count: first.toolCalls.length }, 'Tools executing')

            const toolMessages: ChatMessage[] = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: query },
                { role: 'assistant', content: first.content, tool_calls: first.toolCalls }
            ]

            for (const tc of first.toolCalls) {
                try {
                    const toolResult = await executeTool(
                        tc.function.name,
                        JSON.parse(tc.function.arguments),
                        patient
                    )
                    toolMessages.push({ role: 'tool', content: toolResult.answer, tool_call_id: tc.id })
                } catch (err) {
                    toolMessages.push({ role: 'tool', content: `Ошибка: ${String(err)}`, tool_call_id: tc.id })
                }
            }

            const second = await chat(toolMessages)
            return { content: second.content, usedTools: true }
        }

        return { content: first.content, usedTools: false }
    }

    if (searchResults.length === 0) {
        const pendingOverrides = isLearningEnabled ? await findPendingOverrides(query) : []
        let overrideStr = ''
        if (pendingOverrides.length > 0) {
            overrideStr =
                `\n\nВАЖНОЕ ИСПРАВЛЕНИЕ АДМИНИСТРАТОРА (УЧЕСТЬ ПРИ ОТВЕТЕ):\n` + pendingOverrides.join('\n')
        }

        const systemMsg =
            injectPrompt(SYSTEM_PROMPT_NO_CONTEXT, baseReplacements) +
            overrideStr +
            `\n\nВАЖНО: Итоговый ответ пользователю сформируй строго на языке: ${debug.language === 'kk' ? 'казахском' : debug.language === 'en' ? 'английском' : 'русском'}.`
        const { content: answer } = await callLlmWithTools(systemMsg)
        return { content: answer, confidence: 'partial', gaps: [] }
    }

    const allScores = searchResults.map((r) => r.score)
    debug.allScores = allScores
    debug.topScore = Math.max(...allScores)
    debug.topChunkSnippet = searchResults[0].text.slice(0, 120).replace(/\n/g, ' ')

    const contextStr = searchResults
        .map((r) => `[релевантность: ${(r.score * 100).toFixed(0)}%]\n${r.text}`)
        .join('\n\n---\n\n')

    const pendingOverrides = isLearningEnabled ? await findPendingOverrides(query) : []
    let overrideStr = ''
    if (pendingOverrides.length > 0) {
        overrideStr = `\n\nВАЖНОЕ ИСПРАВЛЕНИЕ АДМИНИСТРАТОРА (УЧЕСТЬ ПРИ ОТВЕТЕ):\n` + pendingOverrides.join('\n')
    }

    const systemPrompt =
        injectPrompt(SYSTEM_PROMPT_WITH_CONTEXT, {
            ...baseReplacements,
            context: contextStr + overrideStr
        }) +
        `\n\nВАЖНО: Итоговый ответ пользователю сформируй строго на языке: ${debug.language === 'kk' ? 'казахском' : debug.language === 'en' ? 'английском' : 'русском'}.`

    const { content: answer, usedTools } = await callLlmWithTools(systemPrompt)

    const grounding: GroundingResult = usedTools
        ? { passed: true, needsClarification: false }
        : await checkGrounding(answer, searchResults, query)

    debug.groundingPassed = grounding.passed

    if (grounding.needsClarification && grounding.clarificationQuestion) {
        return { content: grounding.clarificationQuestion, confidence: 'partial', gaps: [] }
    }

    return { content: answer, confidence: 'high', gaps: [] }
}
