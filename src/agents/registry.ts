import type { AgentDescriptor, Gap } from './types'

const AGENTS: AgentDescriptor[] = [
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

export function selectNextAgents(gaps: Gap[], calledAgents: string[]): AgentDescriptor[] {
    const candidates: AgentDescriptor[] = []

    // Пытаемся найти агента для каждого critical gap
    const criticalGaps = gaps.filter((g) => g.priority === 'critical')
    const targetGaps = criticalGaps.length > 0 ? criticalGaps : gaps

    for (const targetGap of targetGaps) {
        let candidate = AGENTS.find(
            (a) => a.fillsGaps.includes(targetGap.type) && !calledAgents.includes(a.name) && !candidates.some((c) => c.name === a.name)
        )

        if (!candidate) {
            candidate = AGENTS.find((a) => a.fillsGaps.includes(targetGap.type) && !candidates.some((c) => c.name === a.name))
        }

        if (candidate) {
            candidates.push(candidate)
        }
    }

    return candidates
}

function getAgentNames(): string[] {
    return AGENTS.map((a) => a.name)
}
