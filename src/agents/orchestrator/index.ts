import { findBranchByNameOrCity } from '../../constants/branches'
import { log } from '../../services/logger'
import {
    getConversationContext,
    getLastBotMessage,
    incrementMessageCount,
    updateConversationMetadata
} from '../../services/rag/context'
import { NUDGE_RESPONSES, detectIntentLLM } from '../../services/rag/intent'
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

const PRICES_BOOKING_CTA: Record<'ru' | 'kk' | 'en', string> = {
    ru: 'Хотите, я запишу Вас на консультацию к врачу? Так Вы получите точную стоимость и подходящую именно Вам программу.',
    kk: 'Дәрігердің кеңесіне жазып қоюымды қалайсыз ба? Осылай сіз нақты құн мен өзіңізге сай бағдарламаны біле аласыз.',
    en: 'Would you like me to book you for a doctor consultation? That way you will get an exact price and a program tailored to you.'
}

const BOOKING_DECLINE_RESPONSE: Record<'ru' | 'kk' | 'en', string> = {
    ru: 'Хорошо, если передумаете — обращайтесь!',
    kk: 'Жақсы, егер ойыңыз өзгерсе — хабарласыңыз!',
    en: 'Alright, if you change your mind — feel free to reach out!'
}

const NUDGE_MESSAGE_THRESHOLD = 4
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

async function maybeAppendNudge(
    answer: string,
    patient: PatientInfo | null,
    context: RagContext | undefined,
    messageCount: number,
    lang: 'ru' | 'kk' | 'en'
): Promise<string> {
    if (!context || !patient) return answer
    if (patient.hasBookedConsultation || patient.bookingNudgeOffered) return answer
    if (messageCount < NUDGE_MESSAGE_THRESHOLD) return answer

    await updatePatient(context.senderId, { bookingNudgeOffered: true })
    log.info({ module: 'orchestrator', senderId: context.senderId }, 'Booking nudge appended')

    return `${answer}\n\n${NUDGE_RESPONSES[lang]}`
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
        let bookingHistory = ''
        const ctx = await getConversationContext(context.conversationId)
        if (ctx.history) bookingHistory = ctx.history

        const result = await handleBookingIntent(query, context.senderId, bookingHistory, effectiveLang)
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
        const detectedBranch = findBranchByNameOrCity(query)
        if (detectedBranch) {
            await updatePatient(context.senderId, {
                preferredBranch: detectedBranch.name,
                preferredBranchRef1cId: detectedBranch.ref1cId
            })
        }

        patient = await getPatient(context.senderId)
        patientStr = formatPatientContext(patient)
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

    // Filter empty content and synthesize
    const nonEmptyContent = state.accumulatedContent.filter((c) => c.length > 0)
    let finalAnswer: string
    if (nonEmptyContent.length === 0) {
        finalAnswer = 'Извините, не удалось найти информацию.'
    } else if (
        nonEmptyContent.length === 1 &&
        nonEmptyContent[0].trim().length < 200 &&
        nonEmptyContent[0].trim().endsWith('?')
    ) {
        // Уточняющий вопрос от tool (филиал/гражданство) — вернуть как есть
        finalAnswer = nonEmptyContent[0]
    } else {
        finalAnswer = await synthesizeFinalAnswer(query, nonEmptyContent, effectiveLang, patientStr, history)
    }

    const personalized = personalizeAnswer(finalAnswer, patient)
    let answer = context ? await appendNameQuestion(personalized, patient, context.senderId) : personalized

    // CTA: prices → booking suggestion once per conversation
    // Skip if the tool agent asked for clarifying info (branch/citizenship) — confidence:'low'
    if (
        context &&
        intentResult.type === 'prices' &&
        patient &&
        !patient.hasBookedConsultation &&
        !patient.bookingNudgeOffered &&
        primaryConfidence !== 'low'
    ) {
        await updatePatient(context.senderId, { bookingNudgeOffered: true })
        answer = `${answer}\n\n${PRICES_BOOKING_CTA[effectiveLang]}`
    }

    // Nudge: query only, threshold-based
    if (intentResult.type === 'query') {
        answer = await maybeAppendNudge(answer, patient, context, messageCount, effectiveLang)
    }

    if (context) {
        await incrementMessageCount(context.conversationId)

        // Extract patient data only from substantive (non-clarifying) answers
        const isClarifying = finalAnswer.length < 100 && finalAnswer.trim().endsWith('?')
        if (!isClarifying) {
            await extractPatientData(query, history || 'нет', answer, patient, context.senderId)
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
