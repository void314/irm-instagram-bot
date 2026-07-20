import type { AgentDescriptor, Gap } from './types'

export const AGENTS: AgentDescriptor[] = [
    {
        name: 'tool',
        description: 'Цены на медицинские услуги и расписание врачей',
        fillsGaps: ['price_info', 'schedule_info']
    },
    {
        name: 'rag',
        description: 'База знаний клиники — описания услуг, программ, общая информация',
        fillsGaps: ['service_composition', 'general_knowledge', 'doctor_info']
    },
    {
        name: 'booking',
        description: 'Запись на приём',
        fillsGaps: ['booking_data']
    },
    {
        name: 'objection',
        description: 'Отработка возражений',
        fillsGaps: []
    },
    {
        name: 'conversation',
        description: 'Приветствия, прощания, благодарности',
        fillsGaps: []
    }
]

export function selectNextAgent(gaps: Gap[], calledAgents: string[]): AgentDescriptor | null {
    const criticalGap = gaps.find((g) => g.priority === 'critical')
    const targetGap = criticalGap ?? gaps[0]
    if (!targetGap) return null

    const candidate = AGENTS.find((a) => a.fillsGaps.includes(targetGap.type) && !calledAgents.includes(a.name))

    if (candidate) return candidate

    // fallback: любой агент умеющий этот gap, даже если уже вызывали
    return AGENTS.find((a) => a.fillsGaps.includes(targetGap.type)) ?? null
}

export function getAgentNames(): string[] {
    return AGENTS.map((a) => a.name)
}
