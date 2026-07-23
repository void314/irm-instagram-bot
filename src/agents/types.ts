import type { ChatMessage } from '../services/llm/openrouter'

export interface Gap {
    type: 'price_info' | 'service_composition' | 'schedule_info' | 'doctor_info' | 'general_knowledge' | 'booking_data'
    description: string
    priority: 'critical' | 'nice_to_have'
}

export interface AgentResult {
    content: string
    confidence: 'high' | 'partial' | 'low'
    gaps: Gap[]
    updatedPatient?: Record<string, unknown>
}

export interface AgentDescriptor {
    name: string
    description: string
    fillsGaps: Gap['type'][]
}

type Lang = 'ru' | 'kk' | 'en'

export interface PipelineState {
    query: string
    history: ChatMessage[]
    patientStr: string
    lang: Lang
    accumulatedContent: string[]
    openGaps: Gap[]
    closedGaps: Gap[]
    iteration: number
    senderId: string
    conversationId: bigint
}
