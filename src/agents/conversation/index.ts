import { log } from '../../services/logger'
import { getFastIntentResponse } from '../../services/rag/intent'
import { type PatientInfo, getPatient } from '../../services/rag/patient'
import type { AgentResult } from '../types'

export async function handleConversationIntent(
    query: string,
    detectedLang: 'ru' | 'kk' | 'en',
    senderId: string,
    conversationId: bigint,
    intentType: string,
    isFirstMessage = false
): Promise<AgentResult | null> {
    const patient = await getPatient(senderId)

    const displayName = getDisplayName(patient)
    const answer = getFastIntentResponse(intentType, detectedLang, { name: displayName, isFirstMessage })
    if (!answer) {
        return null
    }

    log.info({ module: 'agent:conversation', intent: intentType }, 'Handling conversation intent')

    if (intentType === 'clear_context') {
        const { conversations } = await import('../../db/schema')
        const { db } = await import('../../db/client')
        const { eq } = await import('drizzle-orm')
        await db.update(conversations).set({ summary: null, metadata: null }).where(eq(conversations.id, conversationId))
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
