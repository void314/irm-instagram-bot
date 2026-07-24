import { env } from '../../config/constants'
import { chat } from '../llm/openrouter'
import { log } from '../logger'

export interface IntentResult {
    intents: Array<
        | 'greeting' // приветствие
        | 'goodbye' // прощание
        | 'gratitude' // спасибо
        | 'clear_context' // очистить контекст
        | 'objection' // работа с возрождением
        | 'query'
        | 'booking'
        | 'prices'
    >
}

const VALID_TYPES = ['greeting', 'goodbye', 'gratitude', 'clear_context', 'objection', 'query', 'booking', 'prices'] as const

const GOODBYE_RESPONSES: Record<'ru' | 'kk' | 'en', string> = {
    ru: 'До свидания! Благодарим за обращение в IRM Clinic. Всего доброго!',
    kk: 'Сау болыңыз! IRM Clinic-ке хабарласқаныңызға рахмет. Тек жақсылық тілейміз!',
    en: 'Goodbye! Thank you for contacting IRM Clinic. All the best!'
}

const GOODBYE_RESPONSES_NAMED: Record<'ru' | 'kk' | 'en', (name: string) => string> = {
    ru: (name) => `До свидания, ${name}! Благодарим за обращение в IRM Clinic. Всего доброго!`,
    kk: (name) => `Сау болыңыз, ${name}! IRM Clinic-ке хабарласқаныңызға рахмет. Тек жақсылық тілейміз!`,
    en: (name) => `Goodbye, ${name}! Thank you for contacting IRM Clinic. All the best!`
}

const GRATITUDE_RESPONSES: Record<'ru' | 'kk' | 'en', string> = {
    ru: 'Пожалуйста! Если у Вас будут вопросы — обращайтесь в IRM Clinic.',
    kk: 'Оқасы жоқ! Сұрақтарыңыз болса, IRM Clinic-ке хабарласыңыз.',
    en: "You're welcome! If you have any questions, please contact IRM Clinic."
}

const GRATITUDE_RESPONSES_NAMED: Record<'ru' | 'kk' | 'en', (name: string) => string> = {
    ru: (name) => `Пожалуйста, ${name}! Если у Вас будут вопросы — обращайтесь в IRM Clinic.`,
    kk: (name) => `Оқасы жоқ, ${name}! Сұрақтарыңыз болса, IRM Clinic-ке хабарласыңыз.`,
    en: (name) => `You're welcome, ${name}! If you have any questions, please contact IRM Clinic.`
}

const CLEAR_CONTEXT_RESPONSES: Record<'ru' | 'kk' | 'en', string> = {
    ru: 'Диалог очищен. Чем я могу Вам помочь?',
    kk: 'Диалог тазартылды. Сізге қалай көмектесе аламын?',
    en: 'Dialog cleared. How can I help you?'
}

export interface GreetingContext {
    name?: string | null
    isFirstMessage?: boolean
}

/**
 * Строит ответ для fast-интентов (goodbye/gratitude/clear_context).
 * Приветствие формируется главным агентом (LLM) на уровне оркестратора.
 */
export function getFastIntentResponse(type: string, language: 'ru' | 'kk' | 'en', ctx: GreetingContext = {}): string | null {
    const lang = language || 'ru'

    if (type === 'goodbye') {
        return ctx.name ? GOODBYE_RESPONSES_NAMED[lang](ctx.name) : GOODBYE_RESPONSES[lang]
    }

    if (type === 'gratitude') {
        return ctx.name ? GRATITUDE_RESPONSES_NAMED[lang](ctx.name) : GRATITUDE_RESPONSES[lang]
    }

    if (type === 'clear_context') {
        return CLEAR_CONTEXT_RESPONSES[lang]
    }

    return null
}

function buildClassificationPrompt(lastBotMessage?: string | null): string {
    let prompt = `You are an ultra-fast, precise intent classification routing engine for IRM fertility clinic.
Analyze the user's last message and classify it into ALL applicable intents from the allowed list.
Return ONLY valid JSON in the format: {"intents": ["intent_1", "intent_2"]}.
If only one intent applies, still return it inside the intents array.
If no specific intent matches, return {"intents": ["query"]}.
Do not answer the user. Do not explain. Do not return a "response" field.

Allowed intents:
- greeting: hello/hi (e.g., "hello", "привет", "сәлем")
- goodbye: bye/farewell
- gratitude: thanks
- clear_context: user explicitly asks to reset/forget the dialog
- booking: user wants to book an appointment, answers a booking-related question, OR declines booking after being offered ("no", "not now", etc.)
- prices: asks about prices OR answers a price-related clarification question (citizenship, branch)
- objection: hesitation/objection (too expensive, will think, call later, etc.)
- query: any other informational question

Rules (most important):
- If the last bot message is a question and the user gives a short direct answer, classify by the topic of that question (booking vs prices) and mark it as query.
- If the last bot message offered booking and the user replies with short agreement ("ok", "yes", "да", "хорошо") => booking.
- If the last bot message offered booking and the user replies with short refusal ("no", "нет", "не хочу", "спасибо не надо") => booking.
- Return multiple intents only when the same message clearly contains multiple independent intents.
- greeting/gratitude/goodbye may be combined with one substantive intent if both are explicitly present.
- query is a fallback intent. Do NOT include query if a more specific intent fully explains the whole message.
- Preserve the most important routing intents first: booking, prices, objection, query, then conversational intents.`

    if (lastBotMessage) {
        prompt += `\n\nLast bot message: ${lastBotMessage}`
    } else {
        prompt += `\n\nThis is the first message in the conversation (no prior context).`
    }

    return prompt
}

function extractJsonObject(raw: string): {
    intents?: unknown
    intent?: unknown
    type?: unknown
    response?: unknown
} {
    const trimmed = raw.trim()
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (fenced) return JSON.parse(fenced[1].trim())

    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1))
    }

    return {}
}

function normalizeIntents(raw: { intents?: unknown; intent?: unknown }): IntentResult['intents'] {
    if (Array.isArray(raw?.intents) && raw.intents.length > 0) {
        return Array.from(new Set(raw.intents)).filter((int) => VALID_TYPES.includes(int as (typeof VALID_TYPES)[number])) as IntentResult['intents']
    }
    if (typeof raw?.intent === 'string' && VALID_TYPES.includes(raw.intent as (typeof VALID_TYPES)[number])) {
        return [raw.intent as (typeof VALID_TYPES)[number]]
    }
    return ['query']
}

export async function detectIntentLLM(query: string, lastBotMessage?: string | null): Promise<IntentResult> {
    try {
        const messages = [
            { role: 'system' as const, content: buildClassificationPrompt(lastBotMessage) },
            { role: 'user' as const, content: query }
        ]

        const result = await chat(messages, {
            model: env.INTENT_MODEL,
            temperature: 0,
            maxTokens: 150,
            responseFormat: { type: 'json_object' }
        })

        const parsed = extractJsonObject(result.content)
        log.debug(
            {
                module: 'rag:intent',
                model: env.INTENT_MODEL,
                contentLength: result.content.length,
                parsedKeys: parsed
            },
            'Intent classifier parsed result'
        )

        return { intents: normalizeIntents(parsed) }
    } catch (e) {
        log.error({ module: 'rag:intent', model: env.INTENT_MODEL, error: String(e) }, 'LLM intent detection failed')
        return { intents: ['query'] }
    }
}
