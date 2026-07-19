import { findBranchByNameOrCity } from '../../constants/branches'
import { log } from '../../services/logger'
import { getConversationContext, getPendingInfo, incrementMessageCount } from '../../services/rag/context'
import { detectIntentLLM } from '../../services/rag/intent'
import { detectLanguage } from '../../services/rag/language'
import {
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
    debug.language = detectedLang

    log.info({ module: 'orchestrator', language: detectedLang }, 'Pipeline started')

    // 1. Detect Intent via LLM Routing
    const intentResult = await detectIntentLLM(query)
    debug.intentType = intentResult.type
    log.info({ module: 'orchestrator', intent: intentResult.type, language: detectedLang }, 'Intent detected')

    // 2. Fast Conversation Intents (greeting, goodbye, etc.)
    if (context && ['greeting', 'goodbye', 'gratitude', 'clear_context'].includes(intentResult.type)) {
        const convRes = await handleConversationIntent(
            query,
            detectedLang,
            context.senderId,
            context.conversationId,
            intentResult.type
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
        let history = ''
        const ctx = await getConversationContext(context.conversationId)
        if (ctx.history) history = ctx.history

        const answer = await handleBookingIntent(query, context.senderId, history, detectedLang)

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

    // 3. Load Context & Patient Info
    let history = ''
    let patientStr = ''
    let patient = null
    let convoMetadata = null
    let pendingInfo = null

    if (context) {
        const ctx = await getConversationContext(context.conversationId)
        debug.historyLength = ctx.history.length
        if (ctx.history) history = ctx.history
        convoMetadata = ctx.metadata
        pendingInfo = getPendingInfo(ctx.metadata)

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

    // 4. Pending Info Resolution
    if (context && pendingInfo && pendingInfo.type === 'prices') {
        const { answer, missingInfo, updatedPatient } = await handlePriceIntent(
            query,
            patient,
            context.senderId,
            context.conversationId,
            convoMetadata
        )

        const finalAnswer = personalizeAnswer(answer, updatedPatient)
        await incrementMessageCount(context.conversationId)

        if (!missingInfo && updatedPatient) {
            const dialogue = buildDialogueForExtraction(query, history || 'нет', finalAnswer)
            const updates = await extractPatientInfoFromDialogue(dialogue, updatedPatient)
            if (Object.keys(updates).length > 0) {
                await updatePatient(context.senderId, updates)
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

    // 5. Objection Detection
    if (intentResult.type === 'objection') {
        const objectionAnswer = await checkAndHandleObjection(query, detectedLang, patientStr, patient, history)
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

    // 6. Direct Price Intent
    if (intentResult.type === 'prices') {
        const { answer, missingInfo, updatedPatient } = await handlePriceIntent(
            query,
            patient,
            context ? context.senderId : '',
            context ? context.conversationId : BigInt(0),
            convoMetadata,
            detectedLang
        )

        const personalized = personalizeAnswer(answer, updatedPatient)
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
    const finalAnswer = context ? await appendNameQuestion(personalized, patient, context.senderId) : personalized

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
