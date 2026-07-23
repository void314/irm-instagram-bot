import { type ChatMessage, chat } from '../../services/llm/openrouter'
import { log } from '../../services/logger'
import { type PatientInfo } from '../../services/rag/patient'
import { OBJECTION_SCRIPTS, SYSTEM_PROMPT_OBJECTION } from '../../services/rag/prompts'
import { executeTool, getToolDefinitions } from '../../services/tools'
import type { AgentResult } from '../types'

function injectPrompt(template: string, replacements: Record<string, string>): string {
    let result = template
    for (const [key, value] of Object.entries(replacements)) {
        result = result.replace(`{${key}}`, value)
    }
    return result
}

function formatToday(): string {
    const now = new Date()
    return now.toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        weekday: 'long'
    })
}

export async function checkAndHandleObjection(
    query: string,
    detectedLang: 'ru' | 'kk' | 'en',
    patientStr: string,
    patient: PatientInfo | null,
    history: ChatMessage[]
): Promise<AgentResult | null> {
    log.info({ module: 'agent:objection', query: query.slice(0, 60) }, 'Handling objection')

    const lang = detectedLang === 'kk' ? 'kk' : detectedLang === 'en' ? 'en' : 'ru'
    const scriptText = Object.values(OBJECTION_SCRIPTS)
        .map((s) => s[lang])
        .join('\n\n---\n\n')

    const systemPrompt =
        injectPrompt(SYSTEM_PROMPT_OBJECTION, {
            scripts: scriptText,
            patientContext: patientStr || '',
            today: formatToday()
        }) + `\n\nВАЖНО: Итоговый ответ пользователю сформируй строго на языке: ${lang === 'kk' ? 'казахском' : lang === 'en' ? 'английском' : 'русском'}.`

    const tools = getToolDefinitions()

    const first = await chat([{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: query }], { tools, tool_choice: 'auto' })

    let answer: string
    if (first.toolCalls && first.toolCalls.length > 0) {
        log.info({ module: 'agent:objection', count: first.toolCalls.length }, 'Executing tools for objection')

        const toolMessages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query },
            { role: 'assistant', content: first.content || '', tool_calls: first.toolCalls }
        ]

        for (const tc of first.toolCalls) {
            try {
                const toolResult = await executeTool(tc.function.name, JSON.parse(tc.function.arguments), patient)
                toolMessages.push({ role: 'tool', content: toolResult.answer, tool_call_id: tc.id })
            } catch (err) {
                toolMessages.push({ role: 'tool', content: `Ошибка: ${String(err)}`, tool_call_id: tc.id })
            }
        }

        const second = await chat(toolMessages)
        answer = second.content || first.content || ''
    } else {
        answer = first.content || ''
    }

    if (!answer) return null
    return { content: answer, confidence: 'high', gaps: [] }
}
