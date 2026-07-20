import { getBranchesList } from '../../constants/branches'
import { type ChatMessage, chat } from '../../services/llm/openrouter'
import { log } from '../../services/logger'
import { type PatientInfo, getPatient, updatePatient } from '../../services/rag/patient'
import { executeTool, getToolDefinitions } from '../../services/tools'
import type { AgentResult } from '../types'

// Маркер завершённой записи в тестовом режиме — по нему детектируем факт
// успешной записи и проставляем hasBookedConsultation. Держим в отдельной
// константе, чтобы промпт и детектор гарантированно ссылались на одну строку.
const COMPLETION_MARKER = '(Тестовый режим)'

const LANG_LABEL: Record<'ru' | 'kk' | 'en', string> = {
    ru: 'русском',
    kk: 'казахском',
    en: 'английском'
}

function describeKnownField(label: string, value: string | null | undefined): string {
    return value
        ? `${label}: ${value} (уже известно, повторно не спрашивай)`
        : `${label}: неизвестно — нужно спросить`
}

function buildKnownPatientBlock(patient: PatientInfo | null, lang: 'ru' | 'kk' | 'en'): string {
    if (!patient) return 'О пациенте пока ничего не известно.'

    const citizenshipLabel =
        patient.citizenship === 'kz' ? 'РК' : patient.citizenship === 'foreign' ? 'иностранный гражданин' : null

    return [
        describeKnownField('ФИО (как обращаться)', patient.name),
        describeKnownField('Телефон', patient.phone),
        describeKnownField('Филиал', patient.preferredBranch),
        describeKnownField('Гражданство', citizenshipLabel),
        describeKnownField('Язык общения', patient.preferredLang || LANG_LABEL[lang])
    ].join('\n')
}

function buildSystemPrompt(patient: PatientInfo | null, lang: 'ru' | 'kk' | 'en'): string {
    return `Ты — Айгерим, консультант клиники репродуктивного здоровья IRM Clinic.
Пациент согласен записаться на консультацию. Твоя задача — довести запись до конца, следуя строгой
последовательности, не пропуская шаги и не спрашивая то, что уже известно.

=== ЧТО УЖЕ ИЗВЕСТНО О ПАЦИЕНТЕ ===
${buildKnownPatientBlock(patient, lang)}

=== ПОСЛЕДОВАТЕЛЬНОСТЬ СБОРА ДАННЫХ ===
Спрашивай по ОДНОМУ недостающему пункту за раз, в естественной беседе (не списком вопросов разом):
1. К какому врачу/специалисту записать (если не указано — уточни специализацию; используй инструмент
   get_doctor_schedule, чтобы найти врача по имени/специализации и проверить его расписание).
2. Удобный день и время (сверься с расписанием врача из get_doctor_schedule, если оно уже получено).
3. Филиал клиники — если ещё не известен. Доступные филиалы: ${getBranchesList()}.
4. Язык общения на приёме — если не совпадает с языком переписки или ещё не уточнён.
5. ФИО пациента — если ещё не известно.
6. Номер телефона для подтверждения записи — если ещё не известен.

Если пациент уже называл услугу (например, "ЭКО", "консультация гинеколога") — можешь использовать
инструмент get_prices, чтобы уточнить стоимость консультации и упомянуть её при подтверждении.

=== ЗАВЕРШЕНИЕ ЗАПИСИ ===
Когда ВСЕ пункты 1–6 собраны, выведи ИТОГОВОЕ подтверждение СТРОГО в следующем формате (переведи текст
на язык переписки, но сохрани структуру и обязательно как есть оставь последнюю строку "${COMPLETION_MARKER}"):

Вы успешно записаны на консультацию.

ФИО: <имя>
Дата: <день>
Время: <время>
Филиал: <филиал>
Врач: <врач/специалист>

Пожалуйста, возьмите с собой:
- документ, удостоверяющий личность;
- результаты анализов, если они у Вас есть.

Могу ли я ещё чем-нибудь помочь?

${COMPLETION_MARKER}

=== ЕСЛИ ПАЦИЕНТ ПЕРЕДУМАЛ ===
Если в процессе сбора данных пациент говорит, что не хочет записываться — не настаивай, поблагодари
за обращение и вежливо заверши разговор. НЕ выводи маркер "${COMPLETION_MARKER}" в этом случае.

=== ОБЩИЕ ПРАВИЛА ===
- Обращайся на «Вы», будь вежлива и естественна, не зачитывай длинные списки без необходимости.
- Не придумывай врачей, расписание или цены — используй только данные из инструментов.
- Не ставь диагноз и не давай медицинских гарантий.
- При вызове get_doctor_schedule передавай название врача/специализации на РУССКОМ языке,
  даже если пациент общается на казахском или английском — переведи сам.

ВАЖНО: Весь ответ пациенту формируй строго на языке: ${LANG_LABEL[lang]}.`
}

export async function handleBookingIntent(
    query: string,
    senderId: string,
    history: string,
    lang: 'ru' | 'kk' | 'en' = 'ru'
): Promise<AgentResult> {
    log.info({ module: 'booking' }, 'Handling booking intent')

    const patient = await getPatient(senderId)
    const tools = getToolDefinitions()

    const systemPrompt = buildSystemPrompt(patient, lang)

    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]

    if (history && history !== 'нет') {
        messages.push({ role: 'system', content: `Предыдущий диалог:\n${history}` })
    }

    messages.push({ role: 'user', content: query })

    const first = await chat(messages, { tools, tool_choice: 'auto' })

    let finalAnswer = first.content

    if (first.toolCalls && first.toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: first.content || '', tool_calls: first.toolCalls })

        for (const tc of first.toolCalls) {
            try {
                const toolResult = await executeTool(tc.function.name, JSON.parse(tc.function.arguments), patient)
                messages.push({ role: 'tool', content: toolResult.answer, tool_call_id: tc.id })
            } catch (err) {
                messages.push({ role: 'tool', content: `Ошибка: ${String(err)}`, tool_call_id: tc.id })
            }
        }

        const second = await chat(messages)
        finalAnswer = second.content || finalAnswer
    }

    if (finalAnswer && finalAnswer.includes(COMPLETION_MARKER)) {
        await updatePatient(senderId, { hasBookedConsultation: true })
        log.info({ module: 'booking', senderId }, 'Booking completed in emulation mode')
    }

    const answer = finalAnswer || 'Произошла ошибка при записи. Попробуйте еще раз.'
    return { content: answer, confidence: 'high', gaps: [] }
}
