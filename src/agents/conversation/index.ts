import { log } from '../../services/logger'
import { getFastIntentResponse } from '../../services/rag/intent'
import { type PatientInfo, getPatient, updatePatient } from '../../services/rag/patient'

export async function handleConversationIntent(
    query: string,
    detectedLang: 'ru' | 'kk' | 'en',
    senderId: string,
    conversationId: bigint,
    intentType: string
): Promise<{ answer: string; intent: string } | null> {
    const responseText = getFastIntentResponse(intentType, detectedLang)
    if (!responseText) {
        return null
    }

    log.info({ module: 'agent:conversation', intent: intentType }, 'Handling conversation intent')

    let answer = responseText
    const patient = await getPatient(senderId)

    answer = personalizeAnswer(answer, patient)

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

    return { answer, intent: intentType }
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
