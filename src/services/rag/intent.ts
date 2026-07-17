const GREETINGS = [
    /^(привет|здравствуй(те)?|добр(ый|рое|рый)\s*(утро|день|вечер)|hello|hi|hey|салют|хай|здарова|ку)$/i,
    /^(доброго\s*(времени\s*)?суток|рад\s*видеть|howdy|yo|good\s*(morning|afternoon|evening|day))/i,
    /^(сәлем|сәлеметсіз\s*бе|ассалаумағалейкүм|сау\s*мысыз|қайырлы\s*(таң|күн|кеш))/i
]

const SMALL_TALK = [
    /^(привет|здравствуй(те)?|hello|hi|hey|салем|салют|хай)\s*[,!.\s]+\s*(как\s*(дела|жизнь|настроение|ты|вы)|что\s*(делаешь|нового|слышно)|чё\s*как)/i,
    /^(сәлем|сәлеметсіз\s*бе)\s*[,!.\s]+\s*(қалың\s*қалай|жағдай\s*қалай|не\s*жаңалық|қалайсыз)/i
]

const GOODBYES = [
    /^(пока|до\s*свидания|до\s*встречи|всего\s*доброго|bye|goodbye|bb|бай|увидимся|чао|до\s*связи)/i,
    /^(хорошего\s*дня|удачи|всех\s*благ|see\s*you|later|g2g)/i,
    /^(сау\s*бол(ыңыз)?|көріскенше|кездескенше|қош\s*бол(ыңыз)?|айырлыс|рахмет\s*сау\s*бол)/i
]

const GRATITUDE = [
    /^(спасибо|благодарю|рахмет|thank\s*you|thanks|thx|ty|merci|gracias|сен\s*рақмет)/i,
    /^(большое\s*спасибо|огромное\s*спасибо|thank\s*you\s*very\s*much|much\s*appreciated)/i,
    /^(көп\s*рақмет|үлкен\s*рақмет|алғысым\s*шексіз|ризамын)/i
]

const CLEAR_CONTEXT = [
    /^(очисти|забудь|забыть|сброс|clear|forget|reset|стоп|отмена|нач(ни|и)\s*(заново|сначала))/i
]

export interface IntentResult {
    type: 'greeting' | 'goodbye' | 'gratitude' | 'clear_context' | 'query'
    response?: string
}

const RESPONSES: Record<string, { ru: string; kk: string }> = {
    greeting: {
        ru: 'Здравствуйте! IRM Clinic, консультант Айгерим. Чем я могу Вам помочь?',
        kk: 'Сәлеметсіз бе! IRM Clinic, консультант Айгерим. Сізге қалай көмектесе аламын?'
    },
    goodbye: {
        ru: 'До свидания! Благодарим за обращение в IRM Clinic. Всего доброго!',
        kk: 'Сау болыңыз! IRM Clinic-ке хабарласқаныңызға рахмет. Тек жақсылық тілейміз!'
    },
    gratitude: {
        ru: 'Пожалуйста! Если у Вас будут вопросы — обращайтесь в IRM Clinic.',
        kk: 'Оқасы жоқ! Сұрақтарыңыз болса, IRM Clinic-ке хабарласыңыз.'
    },
    clear_context: {
        ru: 'Диалог очищен. Чем я могу Вам помочь?',
        kk: 'Диалог тазартылды. Сізге қалай көмектесе аламын?'
    }
}

export function detectFastIntent(text: string, language?: 'ru' | 'kk' | 'en'): IntentResult | null {
    const trimmed = text.trim()
    const lang = language ?? 'ru'

    for (const pattern of SMALL_TALK) {
        if (pattern.test(trimmed)) {
            const response = lang === 'kk' ? RESPONSES.greeting.kk : RESPONSES.greeting.ru
            return { type: 'greeting', response }
        }
    }

    for (const pattern of GREETINGS) {
        if (pattern.test(trimmed)) {
            const response = lang === 'kk' ? RESPONSES.greeting.kk : RESPONSES.greeting.ru
            return { type: 'greeting', response }
        }
    }

    for (const pattern of GOODBYES) {
        if (pattern.test(trimmed)) {
            const response = lang === 'kk' ? RESPONSES.goodbye.kk : RESPONSES.goodbye.ru
            return { type: 'goodbye', response }
        }
    }

    for (const pattern of GRATITUDE) {
        if (pattern.test(trimmed)) {
            const response = lang === 'kk' ? RESPONSES.gratitude.kk : RESPONSES.gratitude.ru
            return { type: 'gratitude', response }
        }
    }

    for (const pattern of CLEAR_CONTEXT) {
        if (pattern.test(trimmed)) {
            const response = lang === 'kk' ? RESPONSES.clear_context.kk : RESPONSES.clear_context.ru
            return { type: 'clear_context', response }
        }
    }

    return null
}
