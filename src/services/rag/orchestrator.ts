import { env } from '../../config/constants'
import { findBranchByNameOrCity, getBranchesList } from '../../constants/branches'
import { type ChatMessage, type ToolCall, type ToolDefinition, chat } from '../llm/openrouter'
import { generateEmbedding } from '../llm/openrouter'
import { log } from '../logger'
import { executeTool, getToolDefinitions } from '../tools'
import {
    type PendingInfo,
    getConversationContext,
    getPendingInfo,
    incrementMessageCount,
    setPendingInfo
} from './context'
import { type GroundingResult, checkGrounding } from './grounding'
import { hybridSearch } from './hybrid'
import { detectFastIntent } from './intent'
import { detectLanguage } from './language'
import { detectObjection } from './objection'
import {
    type PatientInfo,
    extractPatientInfoFromDialogue,
    formatPatientContext,
    getPatient,
    updatePatient
} from './patient'
import {
    OBJECTION_SCRIPTS,
    SYSTEM_PROMPT_NO_CONTEXT,
    SYSTEM_PROMPT_OBJECTION,
    SYSTEM_PROMPT_WITH_CONTEXT
} from './prompts'
import { resolveSearchQueries } from './query-rewrite'

import { isBookingIntent, handleBookingIntent } from '../../agents/booking/service'

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

function injectPrompt(template: string, replacements: Record<string, string>): string {
    let result = template
    for (const [key, value] of Object.entries(replacements)) {
        result = result.replace(`{${key}}`, value)
    }
    return result
}

const PRICE_INTENT_RE = /(цен|стоимост|прайс|тариф|поч[её]м|сколько|сколко)/i

const CITIZENSHIP_FOREIGN_RE =
    /(иностран|нерезидент|foreign|non[-\s]?resident|снг|рф|росси|узбек|киргиз|кыргыз|таджик|туркмен|азербайдж|армян|белорус|украин|европ|америк|китай|инд)/i
const CITIZENSHIP_KZ_RE = /(рк|казахстан|kazakhstan|kz|резидент)/i
const CITIZENSHIP_CITIZEN_RE = /гражданин(ка)?/i

function isPriceIntent(text: string): boolean {
    return PRICE_INTENT_RE.test(text)
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

function looksLikeNickname(name: string): boolean {
    return /[0-9_.]/.test(name) || name.trim().length < 3
}

function getDisplayName(patient: PatientInfo | null): string | null {
    if (!patient) return null
    if (patient.name) return patient.name
    if (patient.instagramName && (!patient.nameSource || patient.nameSource === 'instagram')) {
        if (looksLikeNickname(patient.instagramName)) return null
        return patient.instagramName
    }
    return null
}

function personalizeAnswer(answer: string, patient: PatientInfo | null): string {
    const displayName = getDisplayName(patient)
    if (!displayName) return answer

    const trimmed = answer.trim()
    if (trimmed.toLowerCase().startsWith(displayName.toLowerCase())) return answer

    return `${displayName}, ${answer}`
}

async function appendNameQuestion(
    answer: string,
    patient: PatientInfo | null,
    context?: RagContext
): Promise<string> {
    if (!patient || !context) return answer
    if (patient.name || patient.nameChangeOffered) return answer

    let question = 'Подскажите, пожалуйста, как я могу к Вам обращаться?'

    if (patient.nameSource === 'instagram' && patient.instagramName) {
        if (!looksLikeNickname(patient.instagramName)) {
            question = `Подскажите, пожалуйста, могу обращаться к Вам ${patient.instagramName}?`
        }
    }

    await updatePatient(context.senderId, { nameChangeOffered: true })
    return `${answer}\n\n${question}`
}

function detectCitizenship(text: string): 'kz' | 'foreign' | null {
    if (CITIZENSHIP_FOREIGN_RE.test(text)) return 'foreign'
    if (CITIZENSHIP_KZ_RE.test(text)) return 'kz'
    if (CITIZENSHIP_CITIZEN_RE.test(text)) return 'kz'
    return null
}

function buildBranchQuestion(): string {
    return `Пожалуйста, уточните филиал клиники.\nДоступные филиалы:\n${getBranchesList()}`
}

function buildCitizenshipQuestion(): string {
    return 'Подскажите, пожалуйста, Ваше гражданство (гражданин РК или иностранный гражданин) — стоимость услуг отличается.'
}

function removeMissing(
    missing: Array<'branch' | 'citizenship'>,
    item: 'branch' | 'citizenship'
): Array<'branch' | 'citizenship'> {
    return missing.filter((value) => value !== item)
}

function parseHistory(historyStr: string): { role: 'user' | 'assistant'; content: string }[] {
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

const SYNTHETIC_BOOSTS = new Set(['прайс услуги', 'список услуг клиники'])

function pickSemanticQuery(originalQuery: string, searchQueries: string[]): string {
    for (let i = searchQueries.length - 1; i >= 0; i--) {
        const q = searchQueries[i]?.trim().toLowerCase()
        if (!q) continue
        if (!SYNTHETIC_BOOSTS.has(q)) return searchQueries[i]
    }
    return originalQuery
}

function buildDialogueForExtraction(query: string, history: string, answer: string): string {
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

export async function runPipeline(query: string, context?: RagContext, verbose = false): Promise<RagResponse> {
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
        let answer = fastIntent.response!

        if (context) {
            const patient = await getPatient(context.senderId)
            answer = personalizeAnswer(answer, patient)
            if (fastIntent.type === 'greeting') {
                answer = await appendNameQuestion(answer, patient, context)
            }
        }

        if (context && fastIntent.type === 'clear_context') {
            const { conversations } = await import('../../db/schema')
            const { db } = await import('../../db/client')
            const { eq } = await import('drizzle-orm')
            await db
                .update(conversations)
                .set({ summary: null, metadata: null })
                .where(eq(conversations.id, context.conversationId))
        }
        ragLog('fast response', { length: answer.length })
        const res: RagResponse = {
            answer,
            contextChunks: [],
            intent: fastIntent.type,
            needsClarification: false
        }
        if (verbose) res.debug = debug
        return res
    }

    if (context && isBookingIntent(query)) {
        debug.intentType = 'booking'
        ragLog('booking intent detected', { query: query.slice(0, 60) })
        
        let history = ''
        const ctx = await getConversationContext(context.conversationId)
        if (ctx.history) history = ctx.history
            
        const answer = await handleBookingIntent(query, context.senderId, history)
        
        await incrementMessageCount(context.conversationId)
        
        const res: RagResponse = {
            answer,
            contextChunks: [],
            intent: 'booking',
            needsClarification: false
        }
        if (verbose) res.debug = debug
        return res
    }

    let history = ''
    let patientStr = ''
    let patient: PatientInfo | null = null
    let convoMetadata: Record<string, unknown> | null = null
    let pendingInfo: PendingInfo | null = null
    if (context) {
        const ctx = await getConversationContext(context.conversationId)
        debug.historyLength = ctx.history.length
        ragLog('context loaded', {
            conversationId: context.conversationId.toString(),
            messageCount: ctx.messageCount,
            historyLength: debug.historyLength
        })
        if (ctx.history) history = ctx.history
        convoMetadata = ctx.metadata
        pendingInfo = getPendingInfo(ctx.metadata)

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

    if (context && pendingInfo) {
        let remaining = pendingInfo.missing
        let updatedPatient = patient

        if (remaining.includes('branch')) {
            if (!updatedPatient?.preferredBranchRef1cId) {
                const branch = findBranchByNameOrCity(query)
                if (branch) {
                    await updatePatient(context.senderId, {
                        preferredBranch: branch.name,
                        preferredBranchRef1cId: branch.ref1cId
                    })
                    updatedPatient = {
                        ...(updatedPatient ?? {
                            senderId: context.senderId,
                            name: null,
                            instagramName: null,
                            instagramUsername: null,
                            instagramProfilePic: null,
                            citizenship: null,
                            phone: null,
                            preferredLang: null,
                            preferredBranch: null,
                            preferredBranchRef1cId: null,
                            hasBookedConsultation: false,
                            nameSource: null,
                            nameChangeOffered: false
                        }),
                        preferredBranch: branch.name,
                        preferredBranchRef1cId: branch.ref1cId
                    }
                    remaining = removeMissing(remaining, 'branch')
                    ragLog('pending: branch resolved', { branch: branch.name })
                }
            } else {
                remaining = removeMissing(remaining, 'branch')
            }
        }

        if (remaining.includes('citizenship')) {
            if (!updatedPatient?.citizenship) {
                const detected = detectCitizenship(query)
                if (detected) {
                    await updatePatient(context.senderId, { citizenship: detected })
                    updatedPatient = {
                        ...(updatedPatient ?? {
                            senderId: context.senderId,
                            name: null,
                            instagramName: null,
                            instagramUsername: null,
                            instagramProfilePic: null,
                            citizenship: null,
                            phone: null,
                            preferredLang: null,
                            preferredBranch: null,
                            preferredBranchRef1cId: null,
                            hasBookedConsultation: false,
                            nameSource: null,
                            nameChangeOffered: false
                        }),
                        citizenship: detected
                    }
                    remaining = removeMissing(remaining, 'citizenship')
                    ragLog('pending: citizenship resolved', { citizenship: detected })
                }
            } else {
                remaining = removeMissing(remaining, 'citizenship')
            }
        }

        const nextPending = remaining.length > 0 ? { ...pendingInfo, missing: remaining } : null
        await setPendingInfo(context.conversationId, nextPending, convoMetadata)

        if (remaining.length > 0) {
            const baseAnswer = remaining.includes('branch') ? buildBranchQuestion() : buildCitizenshipQuestion()
            const answer = personalizeAnswer(baseAnswer, updatedPatient)
            await incrementMessageCount(context.conversationId)
            const res: RagResponse = { answer, contextChunks: [], intent: 'query', needsClarification: false }
            if (verbose) res.debug = debug
            return res
        }

        let answer = ''
        try {
            answer = await executeTool('get_prices', { query: pendingInfo.query }, updatedPatient)
            ragLog('pending: prices tool direct', { hasPatient: !!updatedPatient })
        } catch (err) {
            ragLog('pending: prices tool error', { error: String(err) })
            answer = 'Не удалось получить цены. Попробуйте ещё раз или уточните филиал и гражданство.'
        }

        answer = personalizeAnswer(answer, updatedPatient)
        answer = await appendNameQuestion(answer, updatedPatient, context)

        await incrementMessageCount(context.conversationId)
        const dialogue = buildDialogueForExtraction(query, history || 'нет', answer)
        if (updatedPatient) {
            const updates = await extractPatientInfoFromDialogue(dialogue, updatedPatient)
            if (Object.keys(updates).length > 0) {
                await updatePatient(context.senderId, updates)
                ragLog('patient: updated', { fields: Object.keys(updates) })
            }
        }

        const res: RagResponse = { answer, contextChunks: [], intent: 'query', needsClarification: false }
        if (verbose) res.debug = debug
        return res
    }

    // Детекция возражений через быстрый LLM-классификатор.
    // Если пользователь возражает — запускаем отдельный мини-пайплайн со скриптами.
    // Objection check ДО isPriceIntent, чтобы «просто узнать цену» тоже обрабатывалось как возражение.
    if (await detectObjection(query)) {
        debug.intentType = 'objection'
        ragLog('objection detected', { query: query.slice(0, 60) })

        const lang = detectedLang === 'kk' ? 'kk' : detectedLang === 'en' ? 'en' : 'ru'
        const scriptText = Object.values(OBJECTION_SCRIPTS)
            .map((s) => s[lang])
            .join('\n\n---\n\n')

        const systemPrompt = injectPrompt(SYSTEM_PROMPT_OBJECTION, {
            scripts: scriptText,
            patientContext: patientStr || '',
            today: formatToday(),
            history: history || 'нет'
        })

        const tools = getToolDefinitions()

        const first = await chat(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: query }
            ],
            { tools, tool_choice: 'auto' }
        )

        let answer: string
        if (first.toolCalls && first.toolCalls.length > 0) {
            ragLog('objection: tools executing', { count: first.toolCalls.length })

            const toolMessages: ChatMessage[] = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: query },
                { role: 'assistant', content: first.content, tool_calls: first.toolCalls }
            ]

            for (const tc of first.toolCalls) {
                try {
                    const result = await executeTool(tc.function.name, JSON.parse(tc.function.arguments), patient)
                    toolMessages.push({ role: 'tool', content: result, tool_call_id: tc.id })
                } catch (err) {
                    toolMessages.push({ role: 'tool', content: `Ошибка: ${String(err)}`, tool_call_id: tc.id })
                }
            }

            const second = await chat(toolMessages)
            answer = second.content
        } else {
            answer = first.content
        }

        const personalizedAnswer = personalizeAnswer(answer, patient)
        const finalAnswer = await appendNameQuestion(personalizedAnswer, patient, context)
        ragLog('objection: response', { length: finalAnswer.length })

        if (context) {
            await incrementMessageCount(context.conversationId)
            const dialogue = buildDialogueForExtraction(query, history || 'нет', finalAnswer)
            if (patient) {
                const updates = await extractPatientInfoFromDialogue(dialogue, patient)
                if (Object.keys(updates).length > 0) {
                    await updatePatient(context.senderId, updates)
                    ragLog('patient: updated', { fields: Object.keys(updates) })
                }
            }
        }

        const res: RagResponse = {
            answer: finalAnswer,
            contextChunks: [],
            intent: 'objection',
            needsClarification: false
        }
        if (verbose) res.debug = debug
        return res
    }

    // Для запросов про цены не полагаемся на решение модели вызвать инструмент.
    // Выполняем get_prices детерминированно и возвращаем результат напрямую.
    if (isPriceIntent(query)) {
        const toolArgs: Record<string, unknown> = { query }
        let updatedPatient = patient

        let detectedCitizenship: 'kz' | 'foreign' | null = null
        if (!updatedPatient?.citizenship) {
            detectedCitizenship = detectCitizenship(query)
            if (detectedCitizenship && context) {
                await updatePatient(context.senderId, { citizenship: detectedCitizenship })
                updatedPatient = {
                    ...(updatedPatient ?? {
                        senderId: context.senderId,
                        name: null,
                        instagramName: null,
                        instagramUsername: null,
                        instagramProfilePic: null,
                        citizenship: null,
                        phone: null,
                        preferredLang: null,
                        preferredBranch: null,
                        preferredBranchRef1cId: null,
                        hasBookedConsultation: false,
                        nameSource: null,
                        nameChangeOffered: false
                    }),
                    citizenship: detectedCitizenship
                }
                ragLog('patient citizenship detected', { citizenship: detectedCitizenship })
            }
        }

        const effectiveCitizenship = updatedPatient?.citizenship ?? detectedCitizenship

        const missing: Array<'branch' | 'citizenship'> = []
        if (!updatedPatient?.preferredBranchRef1cId) missing.push('branch')
        if (!effectiveCitizenship) missing.push('citizenship')

        if (context && missing.length > 0) {
            await setPendingInfo(context.conversationId, { type: 'prices', query, missing }, convoMetadata)
            const baseAnswer = missing.includes('branch') ? buildBranchQuestion() : buildCitizenshipQuestion()
            const answer = personalizeAnswer(baseAnswer, updatedPatient)
            await incrementMessageCount(context.conversationId)
            const res: RagResponse = { answer, contextChunks: [], intent: 'query', needsClarification: false }
            if (verbose) res.debug = debug
            return res
        }

        if (updatedPatient?.preferredBranchRef1cId)
            toolArgs.branch_ref1c_id = updatedPatient.preferredBranchRef1cId
        if (updatedPatient?.preferredBranch) toolArgs.branch_name = updatedPatient.preferredBranch
        if (effectiveCitizenship) toolArgs.citizenship = effectiveCitizenship

        let answer = ''
        try {
            answer = await executeTool('get_prices', toolArgs, updatedPatient)
            ragLog('price intent: tool direct', { hasPatient: !!updatedPatient })
        } catch (err) {
            ragLog('price intent: tool error', { error: String(err) })
            answer = 'Не удалось получить цены. Попробуйте ещё раз или уточните филиал и гражданство.'
        }

        answer = personalizeAnswer(answer, updatedPatient)
        answer = await appendNameQuestion(answer, updatedPatient, context)

        if (context) {
            await incrementMessageCount(context.conversationId)
            const dialogue = buildDialogueForExtraction(query, history || 'нет', answer)
            if (updatedPatient) {
                const updates = await extractPatientInfoFromDialogue(dialogue, updatedPatient)
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

    const parsedHistory = parseHistory(history)
    const searchQueries = await resolveSearchQueries(query, parsedHistory)
    if (searchQueries.length > 1) {
        ragLog('query expansion', { original: query, expanded: searchQueries.slice(1) })
    }

    const semanticQuery = pickSemanticQuery(query, searchQueries)
    ragLog('hybrid search: embedding query', { forQuery: semanticQuery })
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
    ragLog('hybrid search: results', { queries: searchQueries.length, total: searchResults.length })

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
        const personalizedAnswer = personalizeAnswer(answer, patient)
        const finalAnswer = await appendNameQuestion(personalizedAnswer, patient, context)
        ragLog('LLM: response', { length: finalAnswer.length })

        if (context) {
            await incrementMessageCount(context.conversationId)
            const dialogue = buildDialogueForExtraction(query, history || 'нет', finalAnswer)
            if (patient) {
                const updates = await extractPatientInfoFromDialogue(dialogue, patient)
                if (Object.keys(updates).length > 0) {
                    await updatePatient(context.senderId, updates)
                    ragLog('patient: updated', { fields: Object.keys(updates) })
                }
            }
        }

        const res: RagResponse = {
            answer: finalAnswer,
            contextChunks: [],
            intent: 'query',
            needsClarification: false
        }
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
    const rawAnswer = answer
    const personalizedAnswer = personalizeAnswer(rawAnswer, patient)
    ragLog('LLM: response', { length: personalizedAnswer.length, usedTools })

    // Если ответ построен из данных инструмента (цены/расписание), а не из RAG-контекста,
    // релевантность найденных чанков к нему не относится — проверять на них нечего.
    const grounding: GroundingResult = usedTools
        ? { passed: true, needsClarification: false }
        : await checkGrounding(rawAnswer, searchResults, query)
    debug.groundingPassed = grounding.passed
    ragLog('grounding', {
        maxScore: Number(debug.topScore.toFixed(3)),
        skippedDueToTools: usedTools,
        passed: grounding.passed
    })

    if (grounding.needsClarification && grounding.clarificationQuestion) {
        ragLog('clarification', { reason: 'grounding' })
        if (context) await incrementMessageCount(context.conversationId)
        const res: RagResponse = {
            answer: personalizeAnswer(grounding.clarificationQuestion, patient),
            contextChunks: searchResults.map((r) => ({ text: r.text, score: r.score })),
            intent: 'query',
            needsClarification: true
        }
        if (verbose) res.debug = debug
        return res
    }

    const finalAnswer = await appendNameQuestion(personalizedAnswer, patient, context)

    if (context) {
        await incrementMessageCount(context.conversationId)
        const dialogue = buildDialogueForExtraction(query, history || 'нет', finalAnswer)
        if (patient) {
            const updates = await extractPatientInfoFromDialogue(dialogue, patient)
            if (Object.keys(updates).length > 0) {
                await updatePatient(context.senderId, updates)
                ragLog('patient: updated', { fields: Object.keys(updates) })
            }
        }
    }

    const res: RagResponse = {
        answer: finalAnswer,
        contextChunks: searchResults.map((r) => ({ text: r.text, score: r.score })),
        intent: 'query',
        needsClarification: false
    }
    if (verbose) res.debug = debug
    return res
}
