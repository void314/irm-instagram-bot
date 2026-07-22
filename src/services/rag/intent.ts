import { env } from '../../config/constants'
import { chat } from '../llm/openrouter'

export interface IntentResult {
    intents: Array<
        | 'greeting'
        | 'goodbye'
        | 'gratitude'
        | 'clear_context'
        | 'objection'
        | 'query'
        | 'booking'
        | 'booking_decline'
        | 'prices'
        | 'provide_name'
    >
}

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

const GREETING_FULL: Record<'ru' | 'kk' | 'en', string> = {
    ru: 'Здравствуйте! IRM Clinic, AI-консультант Айгерим. Чем я могу Вам помочь?',
    kk: 'Сәлеметсіз бе! IRM Clinic, AI-консультант Айгерим. Сізге қалай көмектесе аламын?',
    en: 'Hello! IRM Clinic, AI consultant Aigerim. How can I help you?'
}

const GREETING_SHORT: Record<'ru' | 'kk' | 'en', string> = {
    ru: 'Чем я могу Вам помочь?',
    kk: 'Сізге қалай көмектесе аламын?',
    en: 'How can I help you?'
}

const GREETING_NAMED: Record<'ru' | 'kk' | 'en', (name: string) => string> = {
    ru: (name) => `Здравствуйте ${name}, AI-консультант IRM-Clinic Айгерим. Чем я могу Вам помочь?`,
    kk: (name) => `Сәлеметсіз бе ${name}, AI-консультант IRM-Clinic Айгерим. Сізге қалай көмектесе аламын?`,
    en: (name) => `Hello ${name}, AI consultant at IRM-Clinic, Aigerim. How can I help you?`
}

const GREETING_CONTINUATION: Record<'ru' | 'kk' | 'en', (name: string) => string> = {
    ru: (name) => `${name}, чем я могу помочь?`,
    kk: (name) => `${name}, сізге қалай көмектесе аламын?`,
    en: (name) => `${name}, how can I help you?`
}

const NAME_ACKNOWLEDGE: Record<'ru' | 'kk' | 'en', (name: string) => string> = {
    ru: (name) =>
        `Приятно познакомиться, ${name}! Расскажите, что Вас привело в IRM Clinic? Я могу рассказать о программах лечения, ценах на услуги или записать Вас на консультацию.`,
    kk: (name) =>
        `Сізбен танысқаныма қуаныштымын, ${name}! Сізді IRM Clinic-ке не алып келгенін айтыңызшы? Емдеу бағдарламалары, қызмет бағалары туралы айтып бере аламын немесе кеңеске жаза аламын.`,
    en: (name) =>
        `Nice to meet you, ${name}! Tell me, what brought you to IRM Clinic? I can tell you about treatment programs, service prices, or book you for a consultation.`
}

export interface GreetingContext {
    name?: string | null
    isFirstMessage?: boolean
}

/**
 * Строит ответ для fast-интентов (greeting/goodbye/gratitude/clear_context).
 * Учитывает: известно ли имя пациента и является ли это первым сообщением в беседе,
 * чтобы не повторять полное представление клиники на каждом сообщении.
 */
export function getFastIntentResponse(
    type: string,
    language: 'ru' | 'kk' | 'en',
    ctx: GreetingContext = {}
): string | null {
    const lang = language || 'ru'

    if (type === 'greeting') {
        if (ctx.isFirstMessage && ctx.name) return GREETING_NAMED[lang](ctx.name)
        if (ctx.isFirstMessage) return GREETING_FULL[lang]
        if (ctx.name) return GREETING_CONTINUATION[lang](ctx.name)
        return GREETING_SHORT[lang]
    }

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

export function getNameAcknowledgeResponse(name: string, language: 'ru' | 'kk' | 'en'): string {
    return NAME_ACKNOWLEDGE[language || 'ru'](name)
}

function buildClassificationPrompt(lastBotMessage?: string | null): string {
    let prompt = `Ты — классификатор намерений пользователя для клиники репродукции IRM.
Проанализируй сообщение пользователя и верни МАССИВ интентов (от 1 до 3) в формате JSON: {"intents": ["...", "..."]}.
Если пользователь задает несколько вопросов разного характера, верни несколько интентов. Например, если он здоровается и спрашивает цену, верни ["greeting", "prices"].

Возможные интенты:
- "greeting": приветствия (здравствуйте, привет, hello, сәлем и т.д.)
- "goodbye": прощания (пока, до свидания, сау бол)
- "gratitude": благодарность (спасибо, рахмет, thanks)
- "clear_context": явная просьба забыть диалог (очисти, забудь, начни сначала)
- "provide_name": пользователь называет своё имя в ответ на вопрос бота "как я могу к Вам обращаться".
  ТОЛЬКО если имя названо ВНЕ контекста оформления записи (обычно в самом начале диалога).
- "booking": явное желание записаться на прием к врачу или на процедуру (запишите меня, хочу на прием),
  ИЛИ ответ на уточняющий вопрос бота в рамках уже идущего процесса записи (врач/специалист, день, время,
  филиал, язык общения, ФИО, телефон — если последнее сообщение бота было частью оформления записи).
  КРИТИЧЕСКИ ВАЖНО: короткие ответы-согласия ("да", "ок", "хорошо", "ага", "записывайте", "давай",
  "yes", "ok", "да ок", "конечно", "верно") в ответ на предложение бота записаться ("Записать вас?",
  "Хотите на консультацию?" и т.п.) — это НЕ отказ, это СОГЛАСИЕ на запись → классифицируй как "booking".
- "booking_decline": отказ от записи на приём. Если последнее сообщение бота содержало предложение
  записаться (вопрос "записать вас?", "хотите на консультацию?" и т.п.), а пользователь ответил коротким
  отказом ("нет", "не надо", "не хочу", "no", "жоқ", "не", "спасибо не надо") — верни "booking_decline".
  ВАЖНО: "ок", "да", "хорошо", "ага", "yes", "записывайте", "давай", "конечно" — это СОГЛАСИЕ на запись,
  их НЕЛЬЗЯ классифицировать как "booking_decline". Для таких ответов используй "booking".
- "prices": вопрос о стоимости услуг, анализов или процедур, ИЛИ ответ на уточняющий вопрос бота о филиале/гражданстве, заданный в рамках обсуждения цен
- "objection": возражение, сомнение (слишком дорого, я подумаю, перезвоню позже, в другой клинике дешевле)
- "query": любые другие информационные вопросы (расписание, какие врачи есть, как проходит ЭКО)

КРИТИЧЕСКИ ВАЖНО — правило продолжения диалога:
Если "Последнее сообщение бота" ниже — это вопрос (просьба уточнить филиал, гражданство, врача, день, время,
язык общения, ФИО, телефон и т.п.), а сообщение пользователя — короткий ответ на этот конкретный вопрос
(название города/филиала, слово "РК"/"иностранный", имя человека, день недели, время, название языка и т.п.) —
классифицируй по теме вопроса бота (т.е. по тому, какой процесс бот вёл — запись на приём или обсуждение цен),
а НЕ как "query". Короткие ответы почти никогда не "query". В частности, если бот в последнем сообщении
собирал данные для записи на приём (спрашивал врача/день/время/филиал/язык/ФИО/телефон в контексте записи) —
классифицируй ответ пользователя как "booking", а не "query".

Примеры:
- Бот: "Пожалуйста, уточните филиал клиники" / Пользователь: "Алматы" → intent: "prices"
- Бот: "Уточните ваше гражданство" / Пользователь: "РК" → intent: "prices"
- Бот (в начале диалога): "Как я могу к Вам обращаться?" / Пользователь: "Артём" → intent: "provide_name"
- Бот (в процессе записи): "Как Вас зовут?" / Пользователь: "Артём" → intent: "booking"
- Бот: "К какому врачу или специалисту Вы бы хотели записаться?" / Пользователь: "К гинекологу" → intent: "booking"
- Бот: "На какой день и время Вам удобно записаться?" / Пользователь: "Завтра после обеда" → intent: "booking"
- Бот: "На каком языке Вам удобно общаться на приёме?" / Пользователь: "Русский язык" → intent: "booking"
- Бот: "Записать вас на консультацию к репродуктологу?" / Пользователь: "ок" → intent: "booking"
- Бот: "Хотите записаться на приём?" / Пользователь: "да" → intent: "booking"
- Бот: "Записать вас на приём?" / Пользователь: "нет" → intent: "booking_decline"`

    if (lastBotMessage) {
        prompt += `\n\nПоследнее сообщение бота: ${lastBotMessage}`
    } else {
        prompt += `\n\nЭто первое сообщение в диалоге (контекста нет).`
    }

    return prompt
}

const VALID_TYPES = [
    'greeting',
    'goodbye',
    'gratitude',
    'clear_context',
    'objection',
    'query',
    'booking',
    'booking_decline',
    'prices',
    'provide_name'
]

export async function detectIntentLLM(query: string, lastBotMessage?: string | null): Promise<IntentResult> {
    try {
        const result = await chat(
            [
                { role: 'system', content: buildClassificationPrompt(lastBotMessage) },
                { role: 'user', content: query }
            ],
            {
                model: env.INTENT_MODEL,
                temperature: 0,
                max_tokens: 100,
                response_format: { type: 'json_object' }
            }
        )

        const parsed = JSON.parse(result.content)

        // Поддержка как нового массива, так и старого формата
        let types: string[] = []
        if (Array.isArray(parsed.intents)) {
            types = parsed.intents
        } else if (typeof parsed.intent === 'string') {
            types = [parsed.intent]
        } else if (typeof parsed.type === 'string') {
            types = [parsed.type]
        }

        const validIntents = types.filter((t) => VALID_TYPES.includes(t)) as IntentResult['intents']

        if (validIntents.length > 0) {
            return { intents: validIntents }
        }

        return { intents: ['query'] }
    } catch (e) {
        console.error('LLM Intent detection failed:', e)
        return { intents: ['query'] }
    }
}
