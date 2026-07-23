import { getBranchesList } from '../../constants/branches'
import { type ChatMessage, chat } from '../../services/llm/openrouter'
import { log } from '../../services/logger'
import { type PatientInfo, getPatient, updatePatient } from '../../services/rag/patient'
import { AIGERIM_CORE } from '../../services/rag/persona'
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

function formatToday(): string {
    const now = new Date()
    return now.toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        weekday: 'long'
    })
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
    return (
        AIGERIM_CORE +
        '\n\n' +
        `Пациент согласен записаться на консультацию. Твоя задача — довести запись до конца, следуя строгой
последовательности, не пропуская шаги и не спрашивая то, что уже известно.

Сегодня: ${formatToday()}
Используй эту дату как точку отсчёта при определении дня недели, чтения расписания врача
и расчёта дат вида "завтра"/"послезавтра"/"на следующей неделе". Не путай день недели и число —
бери оба значения строго из расписания, полученного через get_doctor_schedule, не додумывай их.

=== ЧТО УЖЕ ИЗВЕСТНО О ПАЦИЕНТЕ ===
${buildKnownPatientBlock(patient, lang)}

=== ПОСЛЕДОВАТЕЛЬНОСТЬ СБОРА ДАННЫХ ===
Спрашивай по ОДНОМУ недостающему пункту за раз, в естественной беседе (не списком вопросов разом):
1. Филиал клиники — если ещё не известен. Доступные филиалы: ${getBranchesList()}. Это ОБЯЗАТЕЛЬНО нужно узнать ДО поиска расписания.
2. К какому врачу/специалисту записать (если пациент не указал врача — САМ определи и предложи нужного специалиста исходя из предыдущего диалога. Используй инструмент get_doctor_schedule, чтобы проверить его расписание, обязательно передав филиал).
3. Удобный день и время (сверься с расписанием врача из get_doctor_schedule, если оно уже получено).
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
- Не придумывай врачей, расписание или цены — используй только данные из инструментов.
- При вызове get_doctor_schedule передавай название врача/специализации на РУССКОМ языке,
  даже если пациент общается на казахском или английском — переведи сам.
- Пользователи часто называют примерное время (например, «в 19», «в 5 вечера», «после обеда»).
  Если ближайшее свободное окно в расписании находится в пределах ±15 минут от названного
  пациентом времени — считай это совпадением. В ответе назови точное время из расписания,
  но не отвергай запрос со словами «нет записи на это время». Например: пациент просит «в 19:00»,
  а ближайший слот — 19:07 → отвечай «Записала Вас на 19:07» (без упоминания, что 19:00 недоступно).
- КРИТИЧЕСКИ ВАЖНО: Никогда не предлагай пациенту дату или день, который в расписании
  из get_doctor_schedule помечен как «выходной» или «нет свободного времени». Если день
  помечен как выходной — скажи пациенту, что этот день недоступен, и предложи ближайший
  рабочий день с окнами. Если на конкретную дату, запрошенную пациентом, нет свободных окон —
  честно скажи об этом и предложи ближайшую альтернативу.
- Если в расписании указано «есть занятые окна — N шт., уточни у пациента точное время»,
  ОБЯЗАТЕЛЬНО спроси пациента, на какое конкретное время он хочет записаться, и предупреди,
  что некоторые окна могут быть уже заняты.

ВАЖНО: Весь ответ пациенту формируй строго на языке: ${LANG_LABEL[lang]}.`
    )
}

export async function handleBookingIntent(
    query: string,
    senderId: string,
    history: ChatMessage[],
    lang: 'ru' | 'kk' | 'en' = 'ru'
): Promise<AgentResult> {
    log.info({ module: 'booking' }, 'Handling booking intent')

    const patient = await getPatient(senderId)
    const tools = getToolDefinitions()

    const systemPrompt = buildSystemPrompt(patient, lang)

    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]
    if (history.length > 0) {
        messages.push(...history)
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
