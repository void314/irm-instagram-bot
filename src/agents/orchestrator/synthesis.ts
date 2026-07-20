import { chat } from '../../services/llm/openrouter'
import { IRM_BASE } from '../../services/rag/prompts'

function formatToday(): string {
    const now = new Date()
    return now.toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        weekday: 'long'
    })
}

export async function synthesizeFinalAnswer(
    query: string,
    accumulatedContent: string[],
    lang: 'ru' | 'kk' | 'en',
    patientStr?: string,
    history?: string,
    patientName?: string | null,
    shouldSuggestBooking?: boolean,
    shouldNudgeBooking?: boolean,
    askForName?: boolean
): Promise<string> {
    const patientContext = patientStr || 'Информация о пациенте отсутствует.'
    const dialogueHistory = history || 'нет'

    const extra: string[] = []
    if (patientName) {
        extra.push(
            `Имя пациента: ${patientName}. Используй его в ответе естественно, если это уместно, не форсированно.`
        )
    }
    if (askForName) {
        extra.push(
            'Ты ещё не знаешь имя пациента. Если уместно — вежливо спроси, как к нему обращаться, но не перебивай ответ на его вопрос.'
        )
    }
    if (shouldSuggestBooking) {
        extra.push(
            'Уместно мягко предложить записаться на консультацию. Сделай это одним естественным предложением.'
        )
    }
    if (shouldNudgeBooking) {
        extra.push(
            'Пациент уже задал несколько вопросов. Мягко напомни о возможности записаться на консультацию к врачу.'
        )
    }

    const systemPrompt = [
        IRM_BASE,
        '',
        patientContext,
        `Сегодня: ${formatToday()}`,
        '',
        'История диалога (обязательно учитывай её при ответе):',
        dialogueHistory,
        '',
        ...(extra.length > 0 ? ['', ...extra, ''] : []),
        'Пользователь задал вопрос. Система собрала информацию из нескольких источников.',
        'Составь единый связный ответ, используя ТОЛЬКО предоставленные данные.',
        'Не придумывай цены и факты.',
        '',
        'Данные от агентов:',
        ...accumulatedContent.map((c, i) => `[Источник ${i + 1}]:\n${c}`)
    ].join('\n')

    try {
        const result = await chat(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: query }
            ],
            { model: 'qwen/qwen3.7-max', temperature: 0.3, max_tokens: 800 }
        )
        return result.content.trim()
    } catch {
        return accumulatedContent[0] || 'Извините, не удалось сформировать ответ.'
    }
}
