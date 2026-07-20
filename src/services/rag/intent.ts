import { chat } from '../llm/openrouter'

export interface IntentResult {
    type:
        | 'greeting'
        | 'goodbye'
        | 'gratitude'
        | 'clear_context'
        | 'objection'
        | 'query'
        | 'booking'
        | 'prices'
        | 'provide_name'
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
    ru: 'Здравствуйте! IRM Clinic, консультант Айгерим. Чем я могу Вам помочь?',
    kk: 'Сәлеметсіз бе! IRM Clinic, консультант Айгерим. Сізге қалай көмектесе аламын?',
    en: 'Hello! IRM Clinic, consultant Aigerim. How can I help you?'
}

const GREETING_SHORT: Record<'ru' | 'kk' | 'en', string> = {
    ru: 'Здравствуйте! Расскажите, что Вас привело в IRM Clinic? Я могу рассказать о программах лечения, ценах на услуги или записать Вас на консультацию.',
    kk: 'Сәлеметсіз бе! Сізді IRM Clinic-ке не алып келгенін айтыңызшы? Емдеу бағдарламалары, қызмет бағалары туралы айтып бере аламын немесе кеңеске жаза аламын.',
    en: 'Hello! Tell me, what brought you to IRM Clinic? I can tell you about treatment programs, service prices, or book you for a consultation.'
}

const GREETING_NAMED: Record<'ru' | 'kk' | 'en', (name: string) => string> = {
    ru: (name) =>
        `Здравствуйте, ${name}! Расскажите, что Вас привело в IRM Clinic? Я могу рассказать о программах лечения, ценах на услуги или записать Вас на консультацию.`,
    kk: (name) =>
        `Сәлеметсіз бе, ${name}! Сізді IRM Clinic-ке не алып келгенін айтыңызшы? Емдеу бағдарламалары, қызмет бағалары туралы айтып бере аламын немесе кеңеске жаза аламын.`,
    en: (name) =>
        `Hello, ${name}! Tell me, what brought you to IRM Clinic? I can tell you about treatment programs, service prices, or book you for a consultation.`
}

const NAME_ACKNOWLEDGE: Record<'ru' | 'kk' | 'en', (name: string) => string> = {
    ru: (name) =>
        `Приятно познакомиться, ${name}! Расскажите, что Вас привело в IRM Clinic? Я могу рассказать о программах лечения, ценах на услуги или записать Вас на консультацию.`,
    kk: (name) =>
        `Сізбен танысқаныма қуаныштымын, ${name}! Сізді IRM Clinic-ке не алып келгенін айтыңызшы? Емдеу бағдарламалары, қызмет бағалары туралы айтып бере аламын немесе кеңеске жаза аламын.`,
    en: (name) =>
        `Nice to meet you, ${name}! Tell me, what brought you to IRM Clinic? I can tell you about treatment programs, service prices, or book you for a consultation.`
}

export const NUDGE_RESPONSES: Record<'ru' | 'kk' | 'en', string> = {
    ru: 'Могу я записать Вас на консультацию к врачу-репродуктологу в IRM Clinic? Специалист поможет подобрать программу индивидуально для Вас. Какой день Вам будет удобен?',
    kk: 'Сізді IRM Clinic-те репродуктолог дәрігердің кеңесіне жазуыма бола ма? Маман сізге жеке бағдарлама таңдауға көмектеседі. Қай күн сізге ыңғайлы болады?',
    en: 'May I book you for a consultation with a reproductive specialist at IRM Clinic? The doctor will help select a personalized program for you. What day would be convenient for you?'
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
        if (ctx.name) return GREETING_NAMED[lang](ctx.name)
        if (ctx.isFirstMessage) return GREETING_FULL[lang]
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
Проанализируй сообщение пользователя и верни ТОЛЬКО ОДИН интент из списка ниже в формате JSON: {"intent": "..."}.

Возможные интенты:
- "greeting": приветствия (здравствуйте, привет, hello, сәлем и т.д.)
- "goodbye": прощания (пока, до свидания, сау бол)
- "gratitude": благодарность (спасибо, рахмет, thanks)
- "clear_context": явная просьба забыть диалог (очисти, забудь, начни сначала)
- "provide_name": пользователь называет своё имя в ответ на вопрос бота "как я могу к Вам обращаться" (обычно короткое сообщение из 1-2 слов, похожее на имя)
- "booking": явное желание записаться на прием к врачу или на процедуру (запишите меня, хочу на прием),
  ИЛИ ответ на уточняющий вопрос бота в рамках уже идущего процесса записи (врач/специалист, день, время,
  филиал, язык общения, ФИО, телефон — если последнее сообщение бота было частью оформления записи)
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
- Бот: "Как я могу к Вам обращаться?" / Пользователь: "Артём" → intent: "provide_name"
- Бот: "К какому врачу или специалисту Вы бы хотели записаться?" / Пользователь: "К гинекологу" → intent: "booking"
- Бот: "На какой день и время Вам удобно записаться?" / Пользователь: "Завтра после обеда" → intent: "booking"
- Бот: "На каком языке Вам удобно общаться на приёме?" / Пользователь: "Русский язык" → intent: "booking"`

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
                model: 'openai/gpt-4o-mini',
                temperature: 0,
                max_tokens: 50,
                response_format: { type: 'json_object' }
            }
        )

        const parsed = JSON.parse(result.content)
        const type = parsed.intent || parsed.type || 'query'

        if (VALID_TYPES.includes(type)) {
            return { type: type as IntentResult['type'] }
        }

        return { type: 'query' }
    } catch (e) {
        console.error('LLM Intent detection failed:', e)
        return { type: 'query' }
    }
}
