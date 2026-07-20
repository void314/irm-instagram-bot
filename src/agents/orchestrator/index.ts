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
import { handlePriceIntent } from '../tool'

// Минимальное число сообщений в диалоге (счётчик до текущего хода), после
// которого можно один раз проактивно предложить запись на консультацию,
// если пациент ещё не записан и такое предложение ему ещё не делалось.
const NUDGE_MESSAGE_THRESHOLD = 4

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

/**
 * Проактивно предлагает запись на консультацию, если пациент ещё не записан
 * и такое предложение ему ещё не делалось в этом диалоге. Срабатывает не
 * чаще одного раза на пациента (флаг bookingNudgeOffered), чтобы не спамить
 * этим предложением в каждом сообщении. Не применяется к веткам, где CTA
 * на запись уже встроен в сам ответ (objection, booking, fast-intents).
 */
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

    // 0. Load context & patient info early (for language, last bot message, existence checks)
    let history = ''
    let patientStr = ''
    let patient = null
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

    // Determine language: try fresh detection → fallback to metadata → fallback to 'ru'
    const freshLang = detectLanguage(query)
    if (freshLang) {
        effectiveLang = freshLang
        // Cache language on first confident detection
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

    // 1. Detect Intent via LLM Routing (with last bot message for context)
    const intentResult = await detectIntentLLM(query, lastBotMessage)
    debug.intentType = intentResult.type
    log.info({ module: 'orchestrator', intent: intentResult.type, language: effectiveLang }, 'Intent detected')

    // 2. Fast Conversation Intents (greeting, goodbye, etc.)
    const isFirstMessage = history.trim().length === 0
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
            const res: RagResponse = {
                answer: convRes.answer,
                contextChunks: [],
                intent: convRes.intent,
                needsClarification: false
            }
            if (verbose) res.debug = debug
            return res
        }
    }

    // 3. Booking Intent
    if (context && intentResult.type === 'booking') {
        let bookingHistory = ''
        const ctx = await getConversationContext(context.conversationId)
        if (ctx.history) bookingHistory = ctx.history

        const answer = await handleBookingIntent(query, context.senderId, bookingHistory, effectiveLang)

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

    // 4. Load full patient info for remaining flows
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

    // 5. Objection Detection
    if (intentResult.type === 'objection') {
        const objectionAnswer = await checkAndHandleObjection(query, effectiveLang, patientStr, patient, history)
        if (objectionAnswer) {
            const personalized = personalizeAnswer(objectionAnswer, patient)
            const finalAnswer = context
                ? await appendNameQuestion(personalized, patient, context.senderId)
                : personalized

            if (context) {
                await incrementMessageCount(context.conversationId)
                if (patient) {
                    const dialogue = buildDialogueForExtraction(query, history || 'нет', finalAnswer)
                    const updates = await extractPatientInfoFromDialogue(dialogue, patient)
                    if (Object.keys(updates).length > 0) {
                        await updatePatient(context.senderId, updates)
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
    }

    // 6. Price Intent
    if (intentResult.type === 'prices') {
        const { answer, missingInfo, updatedPatient } = await handlePriceIntent(
            query,
            patient,
            context ? context.senderId : '',
            context ? context.conversationId : BigInt(0),
            effectiveLang,
            history
        )

        const personalized = personalizeAnswer(answer, updatedPatient)
        // Примечание: для ценовых ответов CTA на запись уже встроен детерминированно
        // в сам ответ инструмента (см. BOOKING_CTA в services/tools/prices.ts) —
        // согласно скрипту колл-центра (format.md), после КАЖДОГО ценового ответа
        // должно быть предложение записи, а не раз в N сообщений, как в общем RAG.
        const finalAnswer = context
            ? await appendNameQuestion(personalized, updatedPatient, context.senderId)
            : personalized

        if (context) {
            await incrementMessageCount(context.conversationId)
            if (!missingInfo && updatedPatient) {
                const dialogue = buildDialogueForExtraction(query, history || 'нет', finalAnswer)
                const updates = await extractPatientInfoFromDialogue(dialogue, updatedPatient)
                if (Object.keys(updates).length > 0) {
                    await updatePatient(context.senderId, updates)
                }
            }
        }

        const res: RagResponse = {
            answer: finalAnswer,
            contextChunks: [],
            intent: 'prices',
            needsClarification: false
        }
        if (verbose) res.debug = debug
        return res
    }

    // 7. Standard RAG fallback
    const { answer, needsClarification, searchResults } = await processRagQuery(
        query,
        history,
        patientStr,
        patient,
        debug
    )

    const personalized = personalizeAnswer(answer, patient)
    let finalAnswer = context ? await appendNameQuestion(personalized, patient, context.senderId) : personalized
    finalAnswer = await maybeAppendNudge(finalAnswer, patient, context, messageCount, effectiveLang)

    if (context) {
        await incrementMessageCount(context.conversationId)
        if (patient) {
            const dialogue = buildDialogueForExtraction(query, history || 'нет', finalAnswer)
            const updates = await extractPatientInfoFromDialogue(dialogue, patient)
            if (Object.keys(updates).length > 0) {
                await updatePatient(context.senderId, updates)
            }
        }
    }

    const res: RagResponse = {
        answer: finalAnswer,
        contextChunks: searchResults.map((r) => ({ text: r.text, score: r.score })),
        intent: 'query',
        needsClarification
    }

    if (verbose) res.debug = debug
    return res
}
