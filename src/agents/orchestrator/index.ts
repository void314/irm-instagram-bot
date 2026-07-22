import { findBranchByNameOrCity } from '../../constants/branches'
import { log } from '../../services/logger'
import {
    getConversationContext,
    getLastBotMessage,
    incrementMessageCount,
    updateConversationMetadata
} from '../../services/rag/context'
import { detectIntentLLM } from '../../services/rag/intent'
import { detectLanguage } from '../../services/rag/language'
import {
    type PatientInfo,
    extractPatientInfoFromDialogue,
    formatPatientContext,
    getPatient,
    updatePatient
} from '../../services/rag/patient'
import { handleBookingIntent } from '../booking/service'
import { handleConversationIntent } from '../conversation'
import { checkAndHandleObjection } from '../objection'
import { processRagQuery } from '../rag'
import { selectNextAgents } from '../registry'
import { handlePriceIntent } from '../tool'
import type { AgentResult, PipelineState } from '../types'
import { synthesizeFinalAnswer } from './synthesis'

const BOOKING_DECLINE_RESPONSE: Record<'ru' | 'kk' | 'en', string> = {
    ru: 'Хорошо, если передумаете — обращайтесь!',
    kk: 'Жақсы, егер ойыңыз өзгерсе — хабарласыңыз!',
    en: 'Alright, if you change your mind — feel free to reach out!'
}

const MAX_PIPELINE_ITERATIONS = 3

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

async function extractPatientData(
    query: string,
    history: string,
    answer: string,
    patient: PatientInfo | null,
    senderId: string
): Promise<void> {
    if (!patient) return
    const dialogue = buildDialogueForExtraction(query, history || 'нет', answer)
    const updates = await extractPatientInfoFromDialogue(dialogue, patient)
    if (Object.keys(updates).length > 0) {
        await updatePatient(senderId, updates)
    }
}

function mapIntentToAgentName(intent: string): string {
    switch (intent) {
        case 'prices':
            return 'tool'
        case 'query':
            return 'rag'
        case 'booking':
            return 'booking'
        case 'objection':
            return 'objection'
        default:
            return 'rag'
    }
}

async function dispatchAgent(
    agentName: string,
    query: string,
    state: PipelineState,
    patient: PatientInfo | null,
    history: string,
    debug: RagDebug
): Promise<AgentResult> {
    switch (agentName) {
        case 'tool':
            return handlePriceIntent(query, patient, state.senderId, state.conversationId, state.lang, history)
        case 'rag':
            return processRagQuery(query, history, state.patientStr, patient, debug)
        case 'booking':
            return handleBookingIntent(query, state.senderId, history, state.lang)
        case 'objection':
            return (
                (await checkAndHandleObjection(query, state.lang, state.patientStr, patient, history)) ?? {
                    content: '',
                    confidence: 'low',
                    gaps: []
                }
            )
        default:
            return { content: '', confidence: 'low', gaps: [] }
    }
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

    let history = ''
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
        if (context && !convoMetadata?.language) {
            await updateConversationMetadata(context.conversationId, { language: freshLang }, convoMetadata)
            convoMetadata = { ...(convoMetadata || {}), language: freshLang }
        }
    } else if (convoMetadata?.language === 'kk' || convoMetadata?.language === 'en') {
        effectiveLang = convoMetadata.language
    }

    debug.language = effectiveLang
    log.info(
        { module: 'orchestrator', language: effectiveLang, source: freshLang ? 'fresh' : 'cached' },
        'Pipeline started'
    )

    // Start patient fetch in parallel with intent detection
    const patientPromise: Promise<PatientInfo | null> = context
        ? getPatient(context.senderId)
        : Promise.resolve(null)

    const intentResult = await detectIntentLLM(query, lastBotMessage)
    const detectedIntents = intentResult.intents || ['query']
    debug.intentType = detectedIntents.join(',')
    log.info({ module: 'orchestrator', intents: detectedIntents, language: effectiveLang }, 'Intents detected')

    const isFirstMessage = messageCount === 0

    const substantiveIntents = detectedIntents.filter(
        (i) =>
            !['greeting', 'goodbye', 'gratitude', 'clear_context', 'provide_name', 'booking_decline'].includes(i)
    )

    // --- Pure Fast Paths (when no substantive intent is present) ---
    if (substantiveIntents.length === 0) {
        if (context && detectedIntents.includes('clear_context')) {
            const convRes = await handleConversationIntent(
                query,
                effectiveLang,
                context.senderId,
                context.conversationId,
                'clear_context',
                isFirstMessage
            )
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

        if (context && detectedIntents.includes('booking_decline')) {
            await updatePatient(context.senderId, { bookingNudgeOffered: true })
            await incrementMessageCount(context.conversationId)
            const res: RagResponse = {
                answer: BOOKING_DECLINE_RESPONSE[effectiveLang],
                contextChunks: [],
                intent: 'booking_decline',
                needsClarification: false
            }
            if (verbose) res.debug = debug
            return res
        }

        // Handle other simple conversation intents
        for (const intent of ['greeting', 'goodbye', 'gratitude', 'provide_name'] as const) {
            if (context && detectedIntents.includes(intent as any)) {
                const convRes = await handleConversationIntent(
                    query,
                    effectiveLang,
                    context.senderId,
                    context.conversationId,
                    intent,
                    isFirstMessage
                )
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
        history: history || 'нет',
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

    // We use substantiveIntents if available, else we fall back to detectedIntents
    let pipelineIntents = substantiveIntents.length > 0 ? substantiveIntents : detectedIntents

    // If objection is present, but it falls through (checkAndHandleObjection returns null), we need to fallback.
    // To handle objection properly as an agent, it's mapped in mapIntentToAgentName.
    const primaryAgentsToCall = [...new Set(pipelineIntents.map(mapIntentToAgentName))]

    const results = await Promise.all(
        primaryAgentsToCall.map((agentName) => {
            calledAgents.push(agentName)
            return dispatchAgent(agentName, query, state, patient, history, debug)
        })
    )

    // Merge initial results
    let anyCriticalGaps = false
    let lowestConfidence = 'high'

    for (const result of results) {
        if (result.updatedPatient && patient) {
            patient = { ...patient, ...result.updatedPatient }
        }
        if (result.content) {
            state.accumulatedContent.push(result.content)
        }
        if (result.gaps.length > 0) {
            state.openGaps.push(...result.gaps)
        }
        if (result.gaps.some((g) => g.priority === 'critical')) {
            anyCriticalGaps = true
        }
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
                nextAgents.map((agent) => {
                    calledAgents.push(agent.name)
                    return dispatchAgent(agent.name, query, state, patient, history, debug)
                })
            )

            state.openGaps = [] // Reset gaps for this iteration, will be filled by nextResults

            let iterationCriticalGaps = false
            for (const nextResult of nextResults) {
                if (nextResult.updatedPatient && patient) {
                    patient = { ...patient, ...nextResult.updatedPatient }
                }
                if (nextResult.content) {
                    state.accumulatedContent.push(nextResult.content)
                }
                if (nextResult.gaps.length > 0) {
                    state.openGaps.push(...nextResult.gaps)
                }
                if (nextResult.gaps.some((g) => g.priority === 'critical')) {
                    iterationCriticalGaps = true
                }
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
            if (!iterationCriticalGaps && nextResults.every((r) => r.confidence === 'high' && r.gaps.length === 0))
                break
        }
    }

    // Compute post-processing flags (passed into synthesis for natural integration)
    const patientName = patient?.name || null
    const askForName = !!(patient && !patient.name && !patient.nameChangeOffered)
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

    // Filter empty content and synthesize
    const nonEmptyContent = state.accumulatedContent.filter((c) => c.length > 0)
    let answer: string
    if (nonEmptyContent.length === 0) {
        answer = 'Извините, не удалось найти информацию.'
    } else if (
        nonEmptyContent.length === 1 &&
        nonEmptyContent[0].trim().length < 200 &&
        nonEmptyContent[0].trim().endsWith('?')
    ) {
        // Уточняющий вопрос от tool (филиал/гражданство) — вернуть как есть, без пост-обработки
        answer = nonEmptyContent[0]
    } else {
        answer = await synthesizeFinalAnswer(
            query,
            nonEmptyContent,
            effectiveLang,
            patientStr,
            history,
            patientName,
            shouldSuggestBooking,
            shouldNudgeBooking,
            askForName
        )
    }

    // Fire-and-forget DB side-effects (don't block the response)
    if (context) {
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

        const isClarifying = answer.length < 100 && answer.trim().endsWith('?')
        if (!isClarifying) {
            extractPatientData(query, history || 'нет', answer, patient, context.senderId).catch((err) =>
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
