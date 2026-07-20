import { log } from '../../services/logger'
import { getFastIntentResponse, getNameAcknowledgeResponse } from '../../services/rag/intent'
import { type PatientInfo, getPatient, updatePatient } from '../../services/rag/patient'
import type { AgentResult } from '../types'

/**
 * Простая валидация "похоже ли это на имя", а не классификация интента.
 * Сама классификация (что пользователь отвечает на вопрос об имени) уже сделана LLM
 * в detectIntentLLM — здесь только санити-чек значения перед сохранением в БД.
 */
function extractNameCandidate(text: string): string | null {
    const trimmed = text.trim()
    if (trimmed.length < 2 || trimmed.length > 40) return null
    if (/[0-9@#{}[\]<>/\\]/.test(trimmed)) return null
    if (/[?!]/.test(trimmed)) return null

    const words = trimmed.split(/\s+/).filter(Boolean)
    if (words.length === 0 || words.length > 3) return null

    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
}

export async function handleConversationIntent(
    query: string,
    detectedLang: 'ru' | 'kk' | 'en',
    senderId: string,
    conversationId: bigint,
    intentType: string,
    isFirstMessage = false
): Promise<AgentResult | null> {
    const patient = await getPatient(senderId)

    // Пользователь ответил на вопрос "как я могу к Вам обращаться?"
    if (intentType === 'provide_name') {
        const nameCandidate = extractNameCandidate(query)
        if (!nameCandidate) {
            // Не похоже на имя — пусть падает дальше в RAG/другие ветки, а не форсим сохранение мусора
            return null
        }

        await updatePatient(senderId, { name: nameCandidate, nameSource: 'user', nameChangeOffered: true })
        log.info({ module: 'agent:conversation', senderId, intent: 'provide_name' }, 'Patient name saved')

        return { content: getNameAcknowledgeResponse(nameCandidate, detectedLang), confidence: 'high', gaps: [] }
    }

    const displayName = getDisplayName(patient)
    const responseText = getFastIntentResponse(intentType, detectedLang, { name: displayName, isFirstMessage })
    if (!responseText) {
        return null
    }

    log.info({ module: 'agent:conversation', intent: intentType }, 'Handling conversation intent')

    let answer = responseText

    if (intentType === 'greeting') {
        answer = await appendNameQuestion(answer, patient, senderId)
    }

    if (intentType === 'clear_context') {
        const { conversations } = await import('../../db/schema')
        const { db } = await import('../../db/client')
        const { eq } = await import('drizzle-orm')
        await db
            .update(conversations)
            .set({ summary: null, metadata: null })
            .where(eq(conversations.id, conversationId))
    }

    return { content: answer, confidence: 'high', gaps: [] }
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

/**
 * Используется для персонализации ответов RAG/objection/prices — там, где имя
 * добавляется префиксом перед содержательным ответом. Для conversation-интентов
 * (greeting/goodbye/gratitude) имя уже встроено в сам шаблон ответа естественным
 * образом (см. getFastIntentResponse), поэтому здесь НЕ используется, чтобы избежать
 * дублирования вида "Артём, Здравствуйте, Артём!".
 */
export function personalizeAnswer(answer: string, patient: PatientInfo | null): string {
    const displayName = getDisplayName(patient)
    if (!displayName) return answer

    const trimmed = answer.trim()
    if (trimmed.toLowerCase().startsWith(displayName.toLowerCase())) return answer

    return `${displayName}, ${answer}`
}

export async function appendNameQuestion(
    answer: string,
    patient: PatientInfo | null,
    senderId: string
): Promise<string> {
    if (!patient) return answer
    if (patient.name || patient.nameChangeOffered) return answer

    let question = 'Подскажите, пожалуйста, как я могу к Вам обращаться?'

    if (patient.nameSource === 'instagram' && patient.instagramName) {
        if (!looksLikeNickname(patient.instagramName)) {
            question = `Подскажите, пожалуйста, могу обращаться к Вам ${patient.instagramName}?`
        }
    }

    await updatePatient(senderId, { nameChangeOffered: true })
    return `${answer}\n\n${question}`
}
