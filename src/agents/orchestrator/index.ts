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
import { appendNameQuestion, handleConversationIntent, personalizeAnswer } from '../conversation'
import { checkAndHandleObjection } from '../objection'
import { processRagQuery } from '../rag'
import { selectNextAgent } from '../registry'
import { handlePriceIntent } from '../tool'
import type { AgentResult, Gap, PipelineState } from '../types'
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
    debug.intentType = intentResult.type
    log.info({ module: 'orchestrator', intent: intentResult.type, language: effectiveLang }, 'Intent detected')

    const isFirstMessage = messageCount === 0

    // --- Fast Path: Conversation Intents ---
    if (
        context &&
        ['greeting', 'goodbye', 'gratitude', 'clear_context', 'provide_name'].includes(intentResult.type)
    ) {
        const convRes = await handleConversationIntent(
            query,
            effectiveLang,
            context.senderId,
            context.conversationId,
            intentResult.type,
            isFirstMessage
        )
        if (convRes) {
            if (context) await incrementMessageCount(context.conversationId)
            const res: RagResponse = {
                answer: convRes.content,
                contextChunks: [],
                intent: intentResult.type,
                needsClarification: false
            }
            if (verbose) res.debug = debug
            return res
        }
    }

    // --- Fast Path: Booking Intent ---
    if (context && intentResult.type === 'booking') {
        const result = await handleBookingIntent(query, context.senderId, history || '', effectiveLang)
        await incrementMessageCount(context.conversationId)

        const res: RagResponse = {
            answer: result.content,
            contextChunks: [],
            intent: 'booking',
            needsClarification: false
        }
        if (verbose) res.debug = debug
        return res
    }

    // --- Load patient info for remaining flows ---
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

    // --- Fast Path: Booking Decline ---
    if (context && intentResult.type === 'booking_decline') {
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

    // --- Fast Path: Objection Intent ---
    if (intentResult.type === 'objection') {
        const objectionResult = await checkAndHandleObjection(query, effectiveLang, patientStr, patient, history)
        if (objectionResult) {
            const personalized = personalizeAnswer(objectionResult.content, patient)
            const finalAnswer = context
                ? await appendNameQuestion(personalized, patient, context.senderId)
                : personalized

            if (context) {
                await incrementMessageCount(context.conversationId)
                await extractPatientData(query, history || 'нет', finalAnswer, patient, context.senderId)
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
    }

    // --- Iterative Pipeline ---
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

    // If objection fell through, treat as research query
    const pipelineIntent = intentResult.type === 'objection' ? 'query' : intentResult.type

    // Primary dispatch
    const primaryAgent = mapIntentToAgentName(pipelineIntent)
    calledAgents.push(primaryAgent)

    let result = await dispatchAgent(primaryAgent, query, state, patient, history, debug)
    if (result.updatedPatient && patient) {
        patient = { ...patient, ...result.updatedPatient }
    }
    state.accumulatedContent.push(result.content)

    const primaryConfidence = result.confidence

    // If primary agent has critical gaps → iterative loop
    if (result.gaps.some((g) => g.priority === 'critical')) {
        state.openGaps = result.gaps

        while (state.iteration < MAX_PIPELINE_ITERATIONS) {
            state.iteration++
            const prevGapKey = state.openGaps.map((g) => g.type).join(',')

            const nextAgent = selectNextAgent(state.openGaps, calledAgents)
            if (!nextAgent) break

            calledAgents.push(nextAgent.name)
            const nextResult = await dispatchAgent(nextAgent.name, query, state, patient, history, debug)
            if (nextResult.updatedPatient && patient) {
                patient = { ...patient, ...nextResult.updatedPatient }
            }

            state.accumulatedContent.push(nextResult.content)
            state.openGaps = nextResult.gaps

            // Loop detection: gaps unchanged → prevent infinite loop
            const newGapKey = state.openGaps.map((g) => g.type).join(',')
            if (prevGapKey === newGapKey) {
                log.info(
                    { module: 'orchestrator', iteration: state.iteration, gaps: newGapKey },
                    'Pipeline loop detected, breaking'
                )
                break
            }

            // Early exit if target agent returned high confidence with no gaps
            if (nextResult.confidence === 'high' && nextResult.gaps.length === 0) break
        }
    }

    // Compute post-processing flags (passed into synthesis for natural integration)
    const patientName = patient?.name || null
    const askForName = !!(patient && !patient.name && !patient.nameChangeOffered)
    const shouldSuggestBooking = !!(
        context &&
        intentResult.type === 'prices' &&
        patient &&
        !patient.hasBookedConsultation &&
        !patient.bookingNudgeOffered &&
        primaryConfidence !== 'low'
    )
    const shouldNudgeBooking = !!(
        context &&
        intentResult.type === 'query' &&
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
        intent: intentResult.type === 'prices' ? 'prices' : 'query',
        needsClarification: false
    }

    if (verbose) res.debug = debug
    return res
}
