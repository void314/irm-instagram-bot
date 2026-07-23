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
type PipelineLang = NonNullable<RagDebug['language']>
type ConversationMetadata = Record<string, unknown> & {
    language?: PipelineLang
    bookingInProgress?: boolean
}
type AgentHandler = (query: string, state: PipelineState, patient: PatientInfo | null, history: ChatMessage[], debug: RagDebug) => Promise<AgentResult>
type DispatchResult = { agentName: string; result: AgentResult }
type NamePromptState = {
    patientName: string | null
    askForName: boolean
    suggestedName: string | null
}
type PostProcessingFlags = NamePromptState & {
    shouldSuggestBooking: boolean
    shouldNudgeBooking: boolean
}
type ConversationBootstrap = {
    history: ChatMessage[]
    convoMetadata: ConversationMetadata | null
    lastBotMessage: string | null
    effectiveLang: PipelineLang
    messageCount: number
    languageSource: 'fresh' | 'cached'
}
type PreparedPatientState = {
    patient: PatientInfo | null
    patientStr: string
}
type PipelineExecutionResult = {
    patient: PatientInfo | null
    state: PipelineState
    dataFragments: string[]
    finalFragments: string[]
    primaryConfidence: AgentResult['confidence']
}

const SIMPLE_CONVERSATION_INTENTS = ['goodbye', 'gratitude'] as const

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

function createDebugState(): RagDebug {
    return {
        intentType: 'query',
        historyLength: 0,
        searchResultsCount: 0,
        topScore: 0,
        topChunkSnippet: '',
        allScores: [],
        groundingPassed: true
    }
}

function createPipelineResponse(answer: string, intent: string, verbose: boolean, debug: RagDebug): RagResponse {
    const response: RagResponse = {
        answer,
        contextChunks: [],
        intent,
        needsClarification: false
    }

    if (verbose) response.debug = debug
    return response
}

function logAsyncError(message: string, level: 'error' | 'warn' = 'error') {
    return (err: unknown) => {
        const payload = { module: 'orchestrator', error: String(err) }
        if (level === 'warn') {
            log.warn(payload, message)
            return
        }
        log.error(payload, message)
    }
}

function markBookingInProgress(conversationId: bigint): void {
    if (conversationId <= 0) return

    updateConversationMetadata(conversationId, { bookingInProgress: true }).catch(logAsyncError('Failed to set bookingInProgress'))
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

async function loadConversationBootstrap(query: string, context: RagContext | undefined, debug: RagDebug): Promise<ConversationBootstrap> {
    let history: ChatMessage[] = []
    let convoMetadata: ConversationMetadata | null = null
    let lastBotMessage: string | null = null
    let messageCount = 0

    if (context) {
        const ctx = await getConversationContext(context.conversationId)
        debug.historyLength = ctx.history.length
        if (ctx.history) history = ctx.history
        convoMetadata = (ctx.metadata as ConversationMetadata | null) ?? null
        lastBotMessage = getLastBotMessage(history)
        messageCount = ctx.messageCount
    }

    const freshLang = detectLanguage(query)
    let effectiveLang: PipelineLang = 'ru'

    let languageSource: 'fresh' | 'cached' = 'cached'

    if (freshLang) {
        effectiveLang = freshLang
        languageSource = 'fresh'
        if (context && (!convoMetadata?.language || convoMetadata?.language !== freshLang)) {
            await updateConversationMetadata(context.conversationId, { language: freshLang }, convoMetadata)
            convoMetadata = { ...(convoMetadata || {}), language: freshLang }
        }
    } else {
        effectiveLang = convoMetadata?.language || 'ru'
    }

    debug.language = effectiveLang

    return {
        history,
        convoMetadata,
        lastBotMessage,
        effectiveLang,
        messageCount,
        languageSource
    }
}

function getNamePromptState(patient: PatientInfo | null): NamePromptState {
    const patientName = patient?.name || null
    const askForName = !!(patient && !patient.name && !patient.nameChangeOffered)
    const suggestedName =
        askForName && patient?.nameSource === 'instagram' && patient.instagramName && !looksLikeNickname(patient.instagramName)
            ? patient.instagramName
            : null

    return { patientName, askForName, suggestedName }
}

function buildConversationFacts(detectedIntents: string[]): string[] {
    const facts: string[] = []
    if (detectedIntents.includes('greeting')) facts.push('Пользователь поздоровался.')
    if (detectedIntents.includes('gratitude')) facts.push('Пользователь поблагодарил.')
    if (detectedIntents.includes('goodbye')) facts.push('Пользователь попрощался.')
    return facts
}

async function tryHandleConversationShortcut(
    query: string,
    effectiveLang: PipelineLang,
    context: RagContext,
    intent: 'clear_context' | (typeof SIMPLE_CONVERSATION_INTENTS)[number],
    isFirstMessage: boolean
): Promise<string | null> {
    const result = await handleConversationIntent(query, effectiveLang, context.senderId, context.conversationId, intent, isFirstMessage)
    return result?.content ?? null
}

async function tryHandlePureConversationFastPath(params: {
    query: string
    context?: RagContext
    verbose: boolean
    debug: RagDebug
    detectedIntents: string[]
    effectiveLang: PipelineLang
    isFirstMessage: boolean
    history: ChatMessage[]
    patientPromise: Promise<PatientInfo | null>
}): Promise<RagResponse | null> {
    const { query, context, verbose, debug, detectedIntents, effectiveLang, isFirstMessage, history, patientPromise } = params
    if (!context) return null

    if (detectedIntents.includes('clear_context')) {
        const answer = await tryHandleConversationShortcut(query, effectiveLang, context, 'clear_context', isFirstMessage)
        if (answer) {
            await incrementMessageCount(context.conversationId)
            return createPipelineResponse(answer, 'clear_context', verbose, debug)
        }
    }

    if (detectedIntents.includes('greeting')) {
        const patient = await patientPromise
        const patientStr = formatPatientContext(patient)
        const { patientName, askForName, suggestedName } = getNamePromptState(patient)
        const facts = buildConversationFacts(detectedIntents)
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
        return createPipelineResponse(answer, 'greeting', verbose, debug)
    }

    for (const intent of SIMPLE_CONVERSATION_INTENTS) {
        if (!detectedIntents.includes(intent)) continue

        const answer = await tryHandleConversationShortcut(query, effectiveLang, context, intent, isFirstMessage)
        if (answer) {
            await incrementMessageCount(context.conversationId)
            return createPipelineResponse(answer, intent, verbose, debug)
        }
    }

    return null
}

async function preparePatientState(
    query: string,
    context: RagContext | undefined,
    patientPromise: Promise<PatientInfo | null>
): Promise<PreparedPatientState> {
    if (!context) {
        return { patient: null, patientStr: '' }
    }

    let patient = await patientPromise
    let patientStr = formatPatientContext(patient)
    const detectedBranch = findBranchByNameOrCity(query)

    if (detectedBranch && patient) {
        await updatePatient(context.senderId, {
            preferredBranch: detectedBranch.name,
            preferredBranchRef1cId: detectedBranch.ref1cId
        })
        patient = {
            ...patient,
            preferredBranch: detectedBranch.name,
            preferredBranchRef1cId: detectedBranch.ref1cId
        }
        patientStr = formatPatientContext(patient)
    }

    return { patient, patientStr }
}

function createPipelineState(
    query: string,
    history: ChatMessage[],
    patientStr: string,
    lang: PipelineLang,
    context: RagContext | undefined
): PipelineState {
    return {
        query,
        history,
        patientStr,
        lang,
        accumulatedContent: [],
        openGaps: [],
        closedGaps: [],
        iteration: 0,
        senderId: context?.senderId || '',
        conversationId: context?.conversationId || BigInt(0)
    }
}

async function dispatchAgentBatch(params: {
    agentNames: readonly string[]
    query: string
    state: PipelineState
    patient: PatientInfo | null
    history: ChatMessage[]
    debug: RagDebug
    calledAgents: string[]
}): Promise<DispatchResult[]> {
    const { agentNames, query, state, patient, history, debug, calledAgents } = params

    return Promise.all(
        agentNames.map(async (agentName) => {
            calledAgents.push(agentName)
            const result = await dispatchAgent(agentName, query, state, patient, history, debug)
            return { agentName, result }
        })
    )
}

function recordAgentResult(params: {
    agentName: string
    result: AgentResult
    state: PipelineState
    patient: PatientInfo | null
    dataFragments: string[]
    finalFragments: string[]
}): { patient: PatientInfo | null; hasCriticalGaps: boolean } {
    const { agentName, result, state, dataFragments, finalFragments } = params
    let { patient } = params

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

    return {
        patient,
        hasCriticalGaps: result.gaps.some((gap) => gap.priority === 'critical')
    }
}

function mergeConfidence(current: AgentResult['confidence'], next: AgentResult['confidence']): AgentResult['confidence'] {
    if (next === 'low') return 'low'
    if (next === 'partial' && current !== 'low') return 'partial'
    return current
}

async function executeAgentPipeline(params: {
    query: string
    state: PipelineState
    patient: PatientInfo | null
    history: ChatMessage[]
    debug: RagDebug
    detectedIntents: string[]
    substantiveIntents: string[]
}): Promise<PipelineExecutionResult> {
    const { query, state, history, debug, detectedIntents, substantiveIntents } = params
    let { patient } = params
    const calledAgents: string[] = []
    const dataFragments: string[] = []
    const finalFragments: string[] = []
    const pipelineIntents = substantiveIntents.length > 0 ? substantiveIntents : detectedIntents
    const primaryAgentsToCall = [...new Set(pipelineIntents.map(mapIntentToAgentName))]

    const initialResults = await dispatchAgentBatch({
        agentNames: primaryAgentsToCall,
        query,
        state,
        patient,
        history,
        debug,
        calledAgents
    })

    let anyCriticalGaps = false
    let primaryConfidence: AgentResult['confidence'] = 'high'

    for (const { agentName, result } of initialResults) {
        const recorded = recordAgentResult({
            agentName,
            result,
            state,
            patient,
            dataFragments,
            finalFragments
        })
        patient = recorded.patient
        if (recorded.hasCriticalGaps) anyCriticalGaps = true
        primaryConfidence = mergeConfidence(primaryConfidence, result.confidence)
    }

    if (anyCriticalGaps) {
        const seenGaps = new Set<string>(state.openGaps.map((gap) => gap.type))

        while (state.iteration < MAX_PIPELINE_ITERATIONS) {
            state.iteration++

            const nextAgents = selectNextAgents(state.openGaps, calledAgents)
            if (nextAgents.length === 0) break

            const nextResults = await dispatchAgentBatch({
                agentNames: nextAgents.map((agent) => agent.name),
                query,
                state,
                patient,
                history,
                debug,
                calledAgents
            })

            state.openGaps = []

            let iterationCriticalGaps = false
            let allResolved = true

            for (const { agentName, result } of nextResults) {
                const recorded = recordAgentResult({
                    agentName,
                    result,
                    state,
                    patient,
                    dataFragments,
                    finalFragments
                })
                patient = recorded.patient
                if (recorded.hasCriticalGaps) iterationCriticalGaps = true
                if (result.confidence !== 'high' || result.gaps.length > 0) {
                    allResolved = false
                }
            }

            const newGapTypes = state.openGaps.map((gap) => gap.type)
            const hasNewGaps = newGapTypes.some((gapType) => !seenGaps.has(gapType))

            if (!hasNewGaps && newGapTypes.length > 0) {
                log.info(
                    { module: 'orchestrator', iteration: state.iteration, gaps: newGapTypes.join(',') },
                    'Pipeline loop detected (ping-pong), breaking'
                )
                break
            }

            newGapTypes.forEach((gapType) => seenGaps.add(gapType))

            if (!iterationCriticalGaps && allResolved) break
        }
    }

    return {
        patient,
        state,
        dataFragments,
        finalFragments,
        primaryConfidence
    }
}

function getPostProcessingFlags(params: {
    context?: RagContext
    detectedIntents: string[]
    patient: PatientInfo | null
    primaryConfidence: AgentResult['confidence']
    messageCount: number
}): PostProcessingFlags {
    const { context, detectedIntents, patient, primaryConfidence, messageCount } = params
    const namePromptState = getNamePromptState(patient)

    return {
        ...namePromptState,
        shouldSuggestBooking: !!(
            context &&
            detectedIntents.includes('prices') &&
            patient &&
            !patient.hasBookedConsultation &&
            !patient.bookingNudgeOffered &&
            primaryConfidence !== 'low'
        ),
        shouldNudgeBooking: !!(
            context &&
            detectedIntents.includes('query') &&
            patient &&
            !patient.hasBookedConsultation &&
            !patient.bookingNudgeOffered &&
            messageCount >= 4
        )
    }
}

async function composePipelineAnswer(params: {
    query: string
    dataFragments: string[]
    finalFragments: string[]
    effectiveLang: PipelineLang
    patientStr: string
    history: ChatMessage[]
    flags: PostProcessingFlags
}): Promise<string> {
    const { query, dataFragments, finalFragments, effectiveLang, patientStr, history, flags } = params
    const nonEmptyDataFragments = dataFragments.filter((content) => content.length > 0)
    const nonEmptyFinalFragments = finalFragments.filter((content) => content.length > 0)

    if (nonEmptyDataFragments.length === 0 && nonEmptyFinalFragments.length === 0) {
        return 'Извините, не удалось найти информацию.'
    }
    if (nonEmptyDataFragments.length === 0) {
        return nonEmptyFinalFragments.join('\n\n')
    }

    const craftedAnswer = await craftResponse(
        query,
        nonEmptyDataFragments,
        effectiveLang,
        patientStr,
        history,
        flags.patientName,
        flags.shouldSuggestBooking,
        flags.shouldNudgeBooking,
        flags.askForName,
        flags.suggestedName
    )

    return nonEmptyFinalFragments.length > 0 ? `${nonEmptyFinalFragments.join('\n\n')}\n\n${craftedAnswer}` : craftedAnswer
}

function isClarifyingAnswer(answer: string): boolean {
    return answer.length < 100 && answer.trim().endsWith('?')
}

function runPipelineSideEffects(params: {
    context?: RagContext
    answer: string
    convoMetadata: ConversationMetadata | null
    substantiveIntents: string[]
    state: PipelineState
    shouldSuggestBooking: boolean
    shouldNudgeBooking: boolean
    askForName: boolean
    patient: PatientInfo | null
    query: string
    messageCount: number
}): void {
    const {
        context,
        answer,
        convoMetadata,
        substantiveIntents,
        state,
        shouldSuggestBooking,
        shouldNudgeBooking,
        askForName,
        patient,
        query,
        messageCount
    } = params
    if (!context) return

    const bookingCompleted = answer.includes('(Тестовый режим)')
    const bookingDeclined = !!convoMetadata?.bookingInProgress && substantiveIntents.includes('booking') && !bookingCompleted && state.openGaps.length === 0

    if (bookingDeclined || bookingCompleted) {
        updateConversationMetadata(context.conversationId, { bookingInProgress: false }).catch(logAsyncError('Failed to clear bookingInProgress'))
    }
    if (shouldSuggestBooking || shouldNudgeBooking) {
        updatePatient(context.senderId, { bookingNudgeOffered: true }).catch(logAsyncError('Failed to update booking nudge'))
    }
    if (askForName) {
        updatePatient(context.senderId, { nameChangeOffered: true }).catch(logAsyncError('Failed to update nameChangeOffered'))
    }
    incrementMessageCount(context.conversationId).catch(logAsyncError('Failed to increment message count'))

    const newMessageCount = messageCount + 1
    if (newMessageCount >= 8 && newMessageCount % 4 === 0) {
        updateConversationSummary(context.conversationId).catch(logAsyncError('Failed to update summary', 'warn'))
    }
    if (!isClarifyingAnswer(answer)) {
        extractPatientData(query, answer, patient, context.senderId).catch(logAsyncError('Failed to extract patient data', 'warn'))
    }
}

function getPrimaryIntent(detectedIntents: string[]): string {
    return detectedIntents.includes('prices') ? 'prices' : 'query'
}

export async function runPipeline(query: string, context?: RagContext, verbose = false): Promise<RagResponse> {
    const debug = createDebugState()
    const { history, convoMetadata, lastBotMessage, effectiveLang, messageCount, languageSource } = await loadConversationBootstrap(query, context, debug)

    log.info({ module: 'orchestrator', language: effectiveLang, source: languageSource }, 'Pipeline started')

    const patientPromise: Promise<PatientInfo | null> = context ? getPatient(context.senderId) : Promise.resolve(null)
    const intentResult = await detectIntentLLM(query, lastBotMessage)
    const detectedIntents = intentResult.intents || ['query']
    const substantiveIntents = detectedIntents.filter(isSubstantiveIntent)

    debug.intentType = detectedIntents.join(',')
    log.info({ module: 'orchestrator', intents: detectedIntents, language: effectiveLang }, 'Intents detected')

    if (substantiveIntents.length === 0) {
        const fastPathResponse = await tryHandlePureConversationFastPath({
            query,
            context,
            verbose,
            debug,
            detectedIntents,
            effectiveLang,
            isFirstMessage: messageCount === 0,
            history,
            patientPromise
        })
        if (fastPathResponse) return fastPathResponse
    }

    const preparedPatientState = await preparePatientState(query, context, patientPromise)
    const state = createPipelineState(query, history, preparedPatientState.patientStr, effectiveLang, context)
    const executionResult = await executeAgentPipeline({
        query,
        state,
        patient: preparedPatientState.patient,
        history,
        debug,
        detectedIntents,
        substantiveIntents
    })
    const flags = getPostProcessingFlags({
        context,
        detectedIntents,
        patient: executionResult.patient,
        primaryConfidence: executionResult.primaryConfidence,
        messageCount
    })
    const answer = await composePipelineAnswer({
        query,
        dataFragments: executionResult.dataFragments,
        finalFragments: executionResult.finalFragments,
        effectiveLang,
        patientStr: preparedPatientState.patientStr,
        history,
        flags
    })

    runPipelineSideEffects({
        context,
        answer,
        convoMetadata,
        substantiveIntents,
        state: executionResult.state,
        shouldSuggestBooking: flags.shouldSuggestBooking,
        shouldNudgeBooking: flags.shouldNudgeBooking,
        askForName: flags.askForName,
        patient: executionResult.patient,
        query,
        messageCount
    })

    return createPipelineResponse(answer, getPrimaryIntent(detectedIntents), verbose, debug)
}
