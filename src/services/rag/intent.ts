const GREETINGS = [
    /^(привет|здравствуй(те)?|добр(ый|рое|рый)\s*(утро|день|вечер)|hello|hi|hey|салем|салют|хай|здарова|ку)$/i,
    /^(доброго\s*(времени\s*)?суток|рад\s*видеть|howdy|yo|good\s*(morning|afternoon|evening|day))/i
]

const SMALL_TALK = [
    /^(привет|здравствуй(те)?|hello|hi|hey|салем|салют|хай)\s*[,!.\s]+\s*(как\s*(дела|жизнь|настроение|ты|вы)|что\s*(делаешь|нового|слышно)|чё\s*как)/i
]

const GOODBYES = [
    /^(пока|до\s*свидания|до\s*встречи|всего\s*доброго|bye|goodbye|bb|бай|увидимся|чао|до\s*связи)/i,
    /^(хорошего\s*дня|удачи|всех\s*благ|see\s*you|later|g2g)/i
]

const GRATITUDE = [
    /^(спасибо|благодарю|рахмет|thank\s*you|thanks|thx|ty|merci|gracias|сен\s*рақмет)/i,
    /^(большое\s*спасибо|огромное\s*спасибо|thank\s*you\s*very\s*much|much\s*appreciated)/i
]

const CLEAR_CONTEXT = [
    /^(очисти|забудь|забыть|сброс|clear|forget|reset|стоп|отмена|нач(ни|и)\s*(заново|сначала))/i
]

export interface IntentResult {
    type: 'greeting' | 'goodbye' | 'gratitude' | 'clear_context' | 'query'
    response?: string
}

const RESPONSES: Record<string, string> = {
    greeting: 'Здравствуйте! Чем я могу вам помочь?',
    goodbye: 'До свидания! Если будут вопросы по нашей теме — обращайтесь.',
    gratitude: 'Пожалуйста! Если нужна будет помощь — обращайтесь.',
    clear_context: 'Диалог очищен. Чем я могу вам помочь?'
}

export function detectFastIntent(text: string): IntentResult | null {
    const trimmed = text.trim()

    for (const pattern of SMALL_TALK) {
        if (pattern.test(trimmed)) {
            return { type: 'greeting', response: RESPONSES.greeting }
        }
    }

    for (const pattern of GREETINGS) {
        if (pattern.test(trimmed)) {
            return { type: 'greeting', response: RESPONSES.greeting }
        }
    }

    for (const pattern of GOODBYES) {
        if (pattern.test(trimmed)) {
            return { type: 'goodbye', response: RESPONSES.goodbye }
        }
    }

    for (const pattern of GRATITUDE) {
        if (pattern.test(trimmed)) {
            return { type: 'gratitude', response: RESPONSES.gratitude }
        }
    }

    for (const pattern of CLEAR_CONTEXT) {
        if (pattern.test(trimmed)) {
            return { type: 'clear_context', response: RESPONSES.clear_context }
        }
    }

    return null
}
