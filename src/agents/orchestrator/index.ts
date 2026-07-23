import { findBranchByNameOrCity } from '../../constants/branches'
import type { ChatMessage } from '../../services/llm/openrouter'
import { log } from '../../services/logger'
import {
    getConversationContext,
    getLastBotMessage,
    incrementMessageCount,
    updateConversationMetadata,
    updateConversationSummary
} from '../../services/rag/context'
import { detectIntentLLM } from '../../services/rag/intent'
import { detectLanguage } from '../../services/rag/language'
import { type PatientInfo, extractPatientInfoFromDialogue, formatPatientContext, getPatient, updatePatient } from '../../services/rag/patient'
import { handleBookingIntent } from '../booking/service'
import { handleConversationIntent } from '../conversation'
import { checkAndHandleObjection } from '../objection'
import { processRagQuery } from '../rag'
import { selectNextAgents } from '../registry'
import { handlePriceIntent } from '../tool'
import type { AgentResult, PipelineState } from '../types'
import { craftResponse } from './respond'

const MAX_PIPELINE_ITERATIONS = 1

// Агенты, которые отдают СЫРЫЕ ФАКТЫ (без тона/приветствий/CTA) и поэтому ВСЕГДА
// должны пройти через главного агента (craftResponse), прежде чем попасть к пациенту.
// booking/objection остаются самостоятельными — сами ведут диалог с пациентом и
// возвращают уже готовый, финальный текст (см. решение "Фаза 1" рефакторинга).
const DATA_MODE_AGENTS = new Set(['rag', 'tool'])

const NON_SUBSTANTIVE_INTENTS = new Set(['greeting', 'goodbye', 'gratitude', 'clear_context'])

const INTENT_TO_AGENT = {
    prices: 'tool',
    query: 'rag',
    booking: 'booking',
    objection: 'objection'
} as const

type IntentWithAgent = keyof typeof INTENT_TO_AGENT
type AgentName = (typeof INTENT_TO_AGENT)[IntentWithAgent]
type AgentHandler = (query: string, state: PipelineState, patient: PatientInfo | null, history: ChatMessage[], debug: RagDebug) => Promise<AgentResult>

function isSubstantiveIntent(intent: string): boolean {
    return !NON_SUBSTANTIVE_INTENTS.has(intent)
}

function looksLikeNickname(name: string): boolean {
    return /[0-9_.]/.test(name) || name.trim().length < 3
}

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
    language?: 'ru' | 'kk' | 'en'
}

export interface RagResponse {
    answer: string
    contextChunks: { text: string; score: number }[]
    intent: string
    needsClarification: boolean
    debug?: RagDebug
}

async function extractPatientData(query: string, answer: string, patient: PatientInfo | null, senderId: string): Promise<void> {
    if (!patient) return
    const updates = await extractPatientInfoFromDialogue({ userMessage: query, assistantMessage: answer }, patient)
    if (Object.keys(updates).length > 0) {
        await updatePatient(senderId, updates)
    }
}

function mapIntentToAgentName(intent: string): AgentName {
    return INTENT_TO_AGENT[intent as IntentWithAgent] ?? 'rag'
}

function createEmptyAgentResult(): AgentResult {
    return { content: '', confidence: 'low', gaps: [] }
}

function markBookingInProgress(conversationId: bigint): void {
    if (conversationId <= 0) return

    updateConversationMetadata(conversationId, { bookingInProgress: true }).catch((err) =>
        log.error({ module: 'orchestrator', error: String(err) }, 'Failed to set bookingInProgress')
    )
}

const AGENT_HANDLERS: Record<AgentName, AgentHandler> = {
    tool: async (query, state, patient, history) => handlePriceIntent(query, patient, state.senderId, state.conversationId, state.lang, history),
    rag: async (query, state, patient, history, debug) => processRagQuery(query, history, state.patientStr, patient, debug),
    booking: async (query, state, _patient, history) => {
        markBookingInProgress(state.conversationId)
        return handleBookingIntent(query, state.senderId, history, state.lang)
    },
    objection: async (query, state, patient, history) =>
        (await checkAndHandleObjection(query, state.lang, state.patientStr, patient, history)) ?? createEmptyAgentResult()
}

async function dispatchAgent(
    agentName: string,
    query: string,
    state: PipelineState,
    patient: PatientInfo | null,
    history: ChatMessage[],
    debug: RagDebug
): Promise<AgentResult> {
    const handler = AGENT_HANDLERS[agentName as AgentName]
    if (!handler) return createEmptyAgentResult()
    return handler(query, state, patient, history, debug)
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

    let history: ChatMessage[] = []
    let patientStr = ''
    let patient: PatientInfo | null = null
    let convoMetadata = null
    let lastBotMessage: string | null = null
    let effectiveLang: 'ru' | 'kk' | 'en' = 'ru'
    let messageCount = 0

    if (context) {
        const ctx = await getConversationContext(context.conversationId)
        debug.historyLength = ctx.history.length
        if (ctx.history) history = ctx.history
        convoMetadata = ctx.metadata
        lastBotMessage = getLastBotMessage(history)
        messageCount = ctx.messageCount
    }

    const freshLang = detectLanguage(query)
    if (freshLang) {
        effectiveLang = freshLang
        if (context && (!convoMetadata?.language || convoMetadata?.language !== freshLang)) {
            await updateConversationMetadata(context.conversationId, { language: freshLang }, convoMetadata)
            convoMetadata = { ...(convoMetadata || {}), language: freshLang }
        }
    } else {
        effectiveLang = (convoMetadata?.language as 'ru' | 'kk' | 'en') || 'ru'
    }

    debug.language = effectiveLang
    log.info({ module: 'orchestrator', language: effectiveLang, source: freshLang ? 'fresh' : 'cached' }, 'Pipeline started')

    // Start patient fetch in parallel with intent detection
    const patientPromise: Promise<PatientInfo | null> = context ? getPatient(context.senderId) : Promise.resolve(null)

    const intentResult = await detectIntentLLM(query, lastBotMessage)
    const detectedIntents = intentResult.intents || ['query']
    debug.intentType = detectedIntents.join(',')
    log.info({ module: 'orchestrator', intents: detectedIntents, language: effectiveLang }, 'Intents detected')

    const isFirstMessage = messageCount === 0

    let substantiveIntents = detectedIntents.filter(isSubstantiveIntent)

    // --- Pure Fast Paths (when no substantive intent is present) ---
    if (substantiveIntents.length === 0) {
        if (context && detectedIntents.includes('clear_context')) {
            const convRes = await handleConversationIntent(query, effectiveLang, context.senderId, context.conversationId, 'clear_context', isFirstMessage)
            if (convRes) {
                await incrementMessageCount(context.conversationId)
                const res: RagResponse = {
                    answer: convRes.content,
                    contextChunks: [],
                    intent: 'clear_context',
                    needsClarification: false
                }
                if (verbose) res.debug = debug
                return res
            }
        }

        if (context && detectedIntents.includes('greeting')) {
            patient = await patientPromise
            patientStr = formatPatientContext(patient)

            const patientName = patient?.name || null
            const askForName = !!(patient && !patient.name && !patient.nameChangeOffered)
            const suggestedName =
                askForName && patient?.nameSource === 'instagram' && patient.instagramName && !looksLikeNickname(patient.instagramName)
                    ? patient.instagramName
                    : null

            const facts: string[] = []
            if (detectedIntents.includes('greeting')) facts.push('Пользователь поздоровался.')
            if (detectedIntents.includes('gratitude')) facts.push('Пользователь поблагодарил.')
            if (detectedIntents.includes('goodbye')) facts.push('Пользователь попрощался.')

            const answer = await craftResponse(
                query,
                facts.length > 0 ? facts : ['Запрос относится к разговорному интенту.'],
                effectiveLang,
                patientStr,
                history,
                patientName,
                false,
                false,
                askForName,
                suggestedName
            )

            if (askForName) {
                await updatePatient(context.senderId, { nameChangeOffered: true })
            }

            await incrementMessageCount(context.conversationId)
            const res: RagResponse = {
                answer,
                contextChunks: [],
                intent: 'greeting',
                needsClarification: false
            }
            if (verbose) res.debug = debug
            return res
        }

        // Handle other simple conversation intents
        for (const intent of ['goodbye', 'gratitude'] as const) {
            if (context && detectedIntents.includes(intent as any)) {
                const convRes = await handleConversationIntent(query, effectiveLang, context.senderId, context.conversationId, intent, isFirstMessage)
                if (convRes) {
                    await incrementMessageCount(context.conversationId)
                    const res: RagResponse = {
                        answer: convRes.content,
                        contextChunks: [],
                        intent,
                        needsClarification: false
                    }
                    if (verbose) res.debug = debug
                    return res
                }
            }
        }
    }

    // --- Load patient info for substantive flows ---
    if (context) {
        patient = await patientPromise
        patientStr = formatPatientContext(patient)

        const detectedBranch = findBranchByNameOrCity(query)
        if (detectedBranch && patient) {
            await updatePatient(context.senderId, {
                preferredBranch: detectedBranch.name,
                preferredBranchRef1cId: detectedBranch.ref1cId
            })
            patient.preferredBranch = detectedBranch.name
            patient.preferredBranchRef1cId = detectedBranch.ref1cId
            patientStr = formatPatientContext(patient)
        }
    }

    // --- Iterative Pipeline with Parallel Dispatch ---
    const state: PipelineState = {
        query,
        history,
        patientStr,
        lang: effectiveLang,
        accumulatedContent: [],
        openGaps: [],
        closedGaps: [],
        iteration: 0,
        senderId: context?.senderId || '',
        conversationId: context?.conversationId || BigInt(0)
    }

    const calledAgents: string[] = []

    // Фрагменты от rag/tool (сырые факты — всегда идут через craftResponse) и от
    // booking/objection (уже готовый, самостоятельный ответ — идёт к пациенту как есть).
    const dataFragments: string[] = []
    const finalFragments: string[] = []

    function recordResult(agentName: string, result: AgentResult): boolean {
        if (result.updatedPatient && patient) {
            patient = { ...patient, ...result.updatedPatient }
        }
        if (result.content) {
            if (DATA_MODE_AGENTS.has(agentName)) {
                dataFragments.push(result.content)
            } else {
                finalFragments.push(result.content)
            }
        }
        if (result.gaps.length > 0) {
            state.openGaps.push(...result.gaps)
        }
        return result.gaps.some((g) => g.priority === 'critical')
    }

    // We use substantiveIntents if available, else we fall back to detectedIntents
    let pipelineIntents = substantiveIntents.length > 0 ? substantiveIntents : detectedIntents

    // If objection is present, but it falls through (checkAndHandleObjection returns null), we need to fallback.
    // To handle objection properly as an agent, it's mapped in mapIntentToAgentName.
    const primaryAgentsToCall = [...new Set(pipelineIntents.map(mapIntentToAgentName))]

    const results = await Promise.all(
        primaryAgentsToCall.map(async (agentName) => {
            calledAgents.push(agentName)
            const result = await dispatchAgent(agentName, query, state, patient, history, debug)
            return { agentName, result }
        })
    )

    // Merge initial results
    let anyCriticalGaps = false
    let lowestConfidence = 'high'

    for (const { agentName, result } of results) {
        if (recordResult(agentName, result)) anyCriticalGaps = true
        if (result.confidence === 'low') lowestConfidence = 'low'
        else if (result.confidence === 'partial' && lowestConfidence !== 'low') lowestConfidence = 'partial'
    }

    const primaryConfidence = lowestConfidence

    // If any agent has critical gaps → iterative loop with parallel gap-filling
    if (anyCriticalGaps) {
        const seenGaps = new Set<string>(state.openGaps.map((g) => g.type))

        // Import the new multiple-agent selector if needed, or use it if available
        // selectNextAgents is available in registry.ts
        // Wait, selectNextAgent is currently imported, I'll update the import below

        while (state.iteration < MAX_PIPELINE_ITERATIONS) {
            state.iteration++

            const nextAgents = selectNextAgents(state.openGaps, calledAgents)
            if (!nextAgents || nextAgents.length === 0) break

            const nextResults = await Promise.all(
                nextAgents.map(async (agent) => {
                    calledAgents.push(agent.name)
                    const result = await dispatchAgent(agent.name, query, state, patient, history, debug)
                    return { agentName: agent.name, result }
                })
            )

            state.openGaps = [] // Reset gaps for this iteration, will be filled by nextResults

            let iterationCriticalGaps = false
            for (const { agentName, result: nextResult } of nextResults) {
                if (recordResult(agentName, nextResult)) iterationCriticalGaps = true
            }

            // Loop detection: prevent ping-pong by tracking all seen gaps
            const newGapsTypes = state.openGaps.map((g) => g.type)
            const hasNewGaps = newGapsTypes.some((type) => !seenGaps.has(type))

            if (!hasNewGaps && newGapsTypes.length > 0) {
                log.info(
                    { module: 'orchestrator', iteration: state.iteration, gaps: newGapsTypes.join(',') },
                    'Pipeline loop detected (ping-pong), breaking'
                )
                break
            }

            newGapsTypes.forEach((type) => seenGaps.add(type))

            // Early exit if target agents returned high confidence with no gaps
            if (!iterationCriticalGaps && nextResults.every(({ result }) => result.confidence === 'high' && result.gaps.length === 0)) break
        }
    }

    // Compute post-processing flags (passed into craftResponse for natural integration)
    const patientName = patient?.name || null
    const askForName = !!(patient && !patient.name && !patient.nameChangeOffered)
    const suggestedName =
        askForName && patient?.nameSource === 'instagram' && patient.instagramName && !looksLikeNickname(patient.instagramName)
            ? patient.instagramName
            : null

    const shouldSuggestBooking = !!(
        context &&
        detectedIntents.includes('prices') &&
        patient &&
        !patient.hasBookedConsultation &&
        !patient.bookingNudgeOffered &&
        primaryConfidence !== 'low'
    )
    const shouldNudgeBooking = !!(
        context &&
        detectedIntents.includes('query') &&
        patient &&
        !patient.hasBookedConsultation &&
        !patient.bookingNudgeOffered &&
        messageCount >= 4
    )

    // Собираем финальный ответ. booking/objection уже говорят готовым, финальным
    // текстом от лица Айгерим (самостоятельные агенты, см. DATA_MODE_AGENTS) — их
    // не трогаем. rag/tool отдают только сырые факты, поэтому ГЛАВНЫЙ АГЕНТ
    // (craftResponse) вызывается для них ВСЕГДА — даже если фрагмент один, —
    // потому что сырой факт сам по себе ещё не является ответом пациенту.
    const nonEmptyDataFragments = dataFragments.filter((c) => c.length > 0)
    const nonEmptyFinalFragments = finalFragments.filter((c) => c.length > 0)

    let answer: string
    if (nonEmptyDataFragments.length === 0 && nonEmptyFinalFragments.length === 0) {
        answer = 'Извините, не удалось найти информацию.'
    } else if (nonEmptyDataFragments.length === 0) {
        // Только booking/objection — их ответ уже финальный и цельный
        answer = nonEmptyFinalFragments.join('\n\n')
    } else {
        const craftedAnswer = await craftResponse(
            query,
            nonEmptyDataFragments,
            effectiveLang,
            patientStr,
            history,
            patientName,
            shouldSuggestBooking,
            shouldNudgeBooking,
            askForName,
            suggestedName
        )
        // Редкий случай мультиинтента (например "хочу записаться, сколько стоит?"),
        // когда booking/objection отработали ПАРАЛЛЕЛЬНО с rag/tool — их готовый
        // текст не переписываем, а просто ставим рядом с ответом главного агента.
        answer = nonEmptyFinalFragments.length > 0 ? `${nonEmptyFinalFragments.join('\n\n')}\n\n${craftedAnswer}` : craftedAnswer
    }

    // Fire-and-forget DB side-effects (don't block the response)
    if (context) {
        const bookingCompleted = answer.includes('(Тестовый режим)')
        // We also want to clear bookingInProgress if the booking agent gracefully ended the conversation
        // without outputting the completion marker (e.g. user declined).
        // Since we don't have a specific 'decline' intent anymore, we check if bookingInProgress is true
        // AND we dispatched the booking agent AND it didn't complete.
        // Actually, the simplest check is: if we dispatched booking agent, and it didn't complete, it might have declined.
        // Let's just rely on the fact that if it completed, we clear it. If they decline, we clear it.
        // The booking agent's prompt says "поблагодари за обращение и вежливо заверши разговор"
        // Let's check for "заверши разговор" equivalents or just clear it if they said "no" during booking.
        // For now, let's keep it simple: if the answer doesn't look like an active booking question, we might clear it.
        // Better: let's clear it if the substantive intent was 'booking' but no new gaps were opened and no completion marker was found.

        // Simpler: let's just use a basic string match for common decline words if booking was in progress, or let it expire naturally.
        const bookingDeclined =
            convoMetadata?.bookingInProgress && substantiveIntents.includes('booking') && !bookingCompleted && state.openGaps.length === 0

        if (bookingDeclined || bookingCompleted) {
            updateConversationMetadata(context.conversationId, { bookingInProgress: false }).catch((err) =>
                log.error({ module: 'orchestrator', error: String(err) }, 'Failed to clear bookingInProgress')
            )
        }

        if (shouldSuggestBooking || shouldNudgeBooking) {
            updatePatient(context.senderId, { bookingNudgeOffered: true }).catch((err) =>
                log.error({ module: 'orchestrator', error: String(err) }, 'Failed to update booking nudge')
            )
        }
        if (askForName) {
            updatePatient(context.senderId, { nameChangeOffered: true }).catch((err) =>
                log.error({ module: 'orchestrator', error: String(err) }, 'Failed to update nameChangeOffered')
            )
        }
        incrementMessageCount(context.conversationId).catch((err) =>
            log.error({ module: 'orchestrator', error: String(err) }, 'Failed to increment message count')
        )

        const newMessageCount = messageCount + 1
        if (newMessageCount >= 8 && newMessageCount % 4 === 0) {
            updateConversationSummary(context.conversationId).catch((err) =>
                log.warn({ module: 'orchestrator', error: String(err) }, 'Failed to update summary')
            )
        }

        const isClarifying = answer.length < 100 && answer.trim().endsWith('?')
        if (!isClarifying) {
            extractPatientData(query, answer, patient, context.senderId).catch((err) =>
                log.warn({ module: 'orchestrator', error: String(err) }, 'Failed to extract patient data')
            )
        }
    }

    const res: RagResponse = {
        answer,
        contextChunks: [],
        intent: detectedIntents.includes('prices') ? 'prices' : 'query',
        needsClarification: false
    }

    if (verbose) res.debug = debug
    return res
}
