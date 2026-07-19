import { chat } from '../llm/openrouter'

export interface IntentResult {
    type: 'greeting' | 'goodbye' | 'gratitude' | 'clear_context' | 'objection' | 'query' | 'booking' | 'prices'
}

const RESPONSES: Record<string, { ru: string; kk: string; en: string }> = {
    greeting: {
        ru: 'Здравствуйте! IRM Clinic, консультант Айгерим. Чем я могу Вам помочь?',
        kk: 'Сәлеметсіз бе! IRM Clinic, консультант Айгерим. Сізге қалай көмектесе аламын?',
        en: 'Hello! IRM Clinic, consultant Aigerim. How can I help you?'
    },
    goodbye: {
        ru: 'До свидания! Благодарим за обращение в IRM Clinic. Всего доброго!',
        kk: 'Сау болыңыз! IRM Clinic-ке хабарласқаныңызға рахмет. Тек жақсылық тілейміз!',
        en: 'Goodbye! Thank you for contacting IRM Clinic. All the best!'
    },
    gratitude: {
        ru: 'Пожалуйста! Если у Вас будут вопросы — обращайтесь в IRM Clinic.',
        kk: 'Оқасы жоқ! Сұрақтарыңыз болса, IRM Clinic-ке хабарласыңыз.',
        en: "You're welcome! If you have any questions, please contact IRM Clinic."
    },
    clear_context: {
        ru: 'Диалог очищен. Чем я могу Вам помочь?',
        kk: 'Диалог тазартылды. Сізге қалай көмектесе аламын?',
        en: 'Dialog cleared. How can I help you?'
    }
}

export function getFastIntentResponse(type: string, language: 'ru' | 'kk' | 'en'): string | null {
    if (RESPONSES[type]) {
        return RESPONSES[type][language] || RESPONSES[type]['ru']
    }
    return null
}

const INTENT_CLASSIFICATION_PROMPT = `Ты — классификатор намерений пользователя для клиники репродукции IRM.
Проанализируй сообщение пользователя и верни ТОЛЬКО ОДИН интент из списка ниже в формате JSON.

Возможные интенты:
- "greeting": приветствия (здравствуйте, привет, hello, сәлем и т.д.)
- "goodbye": прощания (пока, до свидания, сау бол)
- "gratitude": благодарность (спасибо, рахмет, thanks)
- "clear_context": явная просьба забыть диалог (очисти, забудь, начни сначала)
- "booking": явное желание записаться на прием к врачу или на процедуру (запишите меня, хочу на прием)
- "prices": вопрос о стоимости услуг, анализов или процедур (сколько стоит, какая цена, бағасы қанша, price)
- "objection": возражение, сомнение (слишком дорого, я подумаю, перезвоню позже, в другой клинике дешевле)
- "query": любые другие информационные вопросы (расписание, какие врачи есть, как проходит ЭКО, где вы находитесь)

Определяй интент строго по сути сообщения. Если человек просто пишет "цена", это prices. Если пишет "запись", это booking.
`

export async function detectIntentLLM(query: string): Promise<IntentResult> {
    try {
        const result = await chat(
            [
                { role: 'system', content: INTENT_CLASSIFICATION_PROMPT },
                { role: 'user', content: query }
            ],
            {
                model: 'openai/gpt-4o-mini', // Используем быструю и дешевую модель для роутинга
                temperature: 0,
                max_tokens: 50,
                response_format: { type: 'json_object' }
            }
        )

        const parsed = JSON.parse(result.content)
        const type = parsed.intent || parsed.type || 'query'

        const validTypes = [
            'greeting',
            'goodbye',
            'gratitude',
            'clear_context',
            'objection',
            'query',
            'booking',
            'prices'
        ]

        if (validTypes.includes(type)) {
            return { type: type as IntentResult['type'] }
        }

        return { type: 'query' }
    } catch (e) {
        console.error('LLM Intent detection failed:', e)
        return { type: 'query' }
    }
}
