import { type ToolDefinition, type ToolCall, type ChatMessage, chat } from '../llm/openrouter'
import { log } from '../logger'
import { detectFastIntent } from './intent'
import { detectLanguage } from './language'
import { hybridSearch } from './hybrid'
import { checkGrounding, type GroundingResult } from './grounding'
import { getConversationContext, incrementMessageCount } from './context'
import { getPatient, formatPatientContext, extractPatientInfoFromDialogue, updatePatient, type PatientInfo } from './patient'
import { findBranchByNameOrCity } from '../../constants/branches'
import { SYSTEM_PROMPT_NO_CONTEXT, SYSTEM_PROMPT_WITH_CONTEXT } from './prompts'
import { getToolDefinitions, executeTool } from '../tools'

export interface RagContext {
    conversationId: bigint
    senderId: string
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

function injectPrompt(
    template: string,
    replacements: Record<string, string>
): string {
    let result = template
    for (const [key, value] of Object.entries(replacements)) {
        result = result.replace(`{${key}}`, value)
    }
    return result
}

function buildDialogueForExtraction(
    query: string,
    history: string,
    answer: string
): string {
    const lines: string[] = []
    if (history && history !== 'нет') {
        lines.push('Предыдущий диалог:')
        lines.push(history)
        lines.push('')
    }
    lines.push(`Пользователь: ${query}`)
    lines.push(`Ассистент: ${answer}`)
    return lines.join('\n')
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
    let patientStr = ''
    let patient: PatientInfo | null = null
    if (context) {
        const ctx = await getConversationContext(context.conversationId)
        debug.historyLength = ctx.history.length
        ragLog('context loaded', {
            conversationId: context.conversationId.toString(),
            messageCount: ctx.messageCount,
            historyLength: debug.historyLength
        })
        if (ctx.history) history = ctx.history

        const detectedBranch = findBranchByNameOrCity(query)
        if (detectedBranch) {
            await updatePatient(context.senderId, {
                preferredBranch: detectedBranch.name,
                preferredBranchRef1cId: detectedBranch.ref1cId
            })
            ragLog('patient branch detected', { branch: detectedBranch.name })
        }

        patient = await getPatient(context.senderId)
        patientStr = formatPatientContext(patient)
        ragLog('patient info', { hasPatient: !!patient, patientStr: patientStr || 'none' })
    }

    ragLog('hybrid search: embedding query')
    const searchResults = await hybridSearch(query)
    debug.searchResultsCount = searchResults.length
    ragLog('hybrid search: results', { count: searchResults.length })

    const tools = getToolDefinitions()
    const baseReplacements: Record<string, string> = {
        history: history || 'нет',
        patientContext: patientStr || ''
    }

    async function callLlm(systemPrompt: string): Promise<{ content: string; toolCalls?: ToolCall[] }> {
        return chat(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: query }
            ],
            {
                tools,
                tool_choice: 'auto'
            }
        )
    }

    async function callLlmWithTools(systemPrompt: string): Promise<{ content: string; usedTools: boolean }> {
        const first = await callLlm(systemPrompt)

        if (first.toolCalls && first.toolCalls.length > 0) {
            ragLog('tools: executing', { count: first.toolCalls.length })

            const toolMessages: ChatMessage[] = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: query },
                { role: 'assistant', content: first.content, tool_calls: first.toolCalls }
            ]

            for (const tc of first.toolCalls) {
                ragLog('tool call', { id: tc.id, name: tc.function.name, args: tc.function.arguments })
                try {
                    const result = await executeTool(tc.function.name, JSON.parse(tc.function.arguments), patient)
                    toolMessages.push({ role: 'tool', content: result, tool_call_id: tc.id })
                } catch (err) {
                    toolMessages.push({ role: 'tool', content: `Ошибка: ${String(err)}`, tool_call_id: tc.id })
                }
            }

            ragLog('tools: result', { count: first.toolCalls.length })
            const second = await chat(toolMessages)
            return { content: second.content, usedTools: true }
        }

        return { content: first.content, usedTools: false }
    }

    if (searchResults.length === 0) {
        const systemMsg = injectPrompt(SYSTEM_PROMPT_NO_CONTEXT, baseReplacements)
        ragLog('LLM: no context')
        const { content: answer } = await callLlmWithTools(systemMsg)
        ragLog('LLM: response', { length: answer.length })

        if (context) {
            await incrementMessageCount(context.conversationId)
            const dialogue = buildDialogueForExtraction(query, history || 'нет', answer)
            if (patient) {
                const updates = await extractPatientInfoFromDialogue(dialogue, patient)
                if (Object.keys(updates).length > 0) {
                    await updatePatient(context.senderId, updates)
                    ragLog('patient: updated', { fields: Object.keys(updates) })
                }
            }
        }

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

    const systemPrompt = injectPrompt(SYSTEM_PROMPT_WITH_CONTEXT, {
        ...baseReplacements,
        context: contextStr
    })

    ragLog('LLM: with context')
    const { content: answer, usedTools } = await callLlmWithTools(systemPrompt)
    ragLog('LLM: response', { length: answer.length, usedTools })

    // Если ответ построен из данных инструмента (цены/расписание), а не из RAG-контекста,
    // релевантность найденных чанков к нему не относится — проверять на них нечего.
    const grounding: GroundingResult = usedTools
        ? { passed: true, needsClarification: false }
        : await checkGrounding(answer, searchResults, query)
    debug.groundingPassed = grounding.passed
    ragLog('grounding', { maxScore: Number(debug.topScore.toFixed(3)), skippedDueToTools: usedTools, passed: grounding.passed })

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

    if (context) {
        await incrementMessageCount(context.conversationId)
        const dialogue = buildDialogueForExtraction(query, history || 'нет', answer)
        if (patient) {
            const updates = await extractPatientInfoFromDialogue(dialogue, patient)
            if (Object.keys(updates).length > 0) {
                await updatePatient(context.senderId, updates)
                ragLog('patient: updated', { fields: Object.keys(updates) })
            }
        }
    }

    const res: RagResponse = {
        answer,
        contextChunks: searchResults.map((r) => ({ text: r.text, score: r.score })),
        intent: 'query',
        needsClarification: false
    }
    if (verbose) res.debug = debug
    return res
}
