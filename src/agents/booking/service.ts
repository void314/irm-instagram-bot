import { getBranchesList } from '../../constants/branches'
import { type ChatMessage, chat } from '../../services/llm/openrouter'
import { log } from '../../services/logger'
import { type PatientInfo, getPatient, updatePatient } from '../../services/rag/patient'
import { executeTool } from '../../services/tools'
import { getToolDefinitions } from '../../services/tools'

const BOOKING_INTENT_RE = /(запис|записа|прием|приём|консультац)/i

export function isBookingIntent(text: string): boolean {
    return BOOKING_INTENT_RE.test(text)
}

export async function handleBookingIntent(query: string, senderId: string, history: string): Promise<string> {
    log.info({ module: 'booking' }, 'Handling booking intent')

    let patient = await getPatient(senderId)
    const tools = getToolDefinitions()

    const systemPrompt = `Ты - ассистент по записи пациентов в клинику репродукции IRM.
Твоя цель - собрать данные для записи на прием.
Для успешной записи нужны: услуга (или к какому врачу), филиал, дата/время (пожелания пользователя), ФИО и номер телефона.
Если чего-то не хватает, задавай уточняющие вопросы.
Если пользователь называет услугу, используй инструмент get_prices чтобы найти ее и убедиться что она есть.
Если пользователь называет врача, используй инструмент find_doctor.
Если все данные собраны, ответь финальной фразой подтверждения записи: "Вы успешно записаны! (Тестовый режим)"
Филиалы клиники: ${getBranchesList()}
`
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]

    if (history && history !== 'нет') {
        messages.push({ role: 'system', content: `Предыдущий диалог:\n${history}` })
    }

    messages.push({ role: 'user', content: query })

    const first = await chat(messages, { tools, tool_choice: 'auto' })

    let finalAnswer = first.content

    if (first.toolCalls && first.toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: first.content, tool_calls: first.toolCalls })

        for (const tc of first.toolCalls) {
            try {
                const result = await executeTool(tc.function.name, JSON.parse(tc.function.arguments), patient)
                messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
            } catch (err) {
                messages.push({ role: 'tool', content: `Ошибка: ${String(err)}`, tool_call_id: tc.id })
            }
        }

        const second = await chat(messages)
        finalAnswer = second.content
    }

    if (finalAnswer.includes('Тестовый режим')) {
        await updatePatient(senderId, { hasBookedConsultation: true })
        log.info({ module: 'booking', senderId }, 'Booking completed in emulation mode')
    }

    return finalAnswer
}
