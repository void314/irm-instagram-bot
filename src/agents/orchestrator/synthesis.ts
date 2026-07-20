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
    history?: string
): Promise<string> {
    const patientContext = patientStr || 'Информация о пациенте отсутствует.'
    const dialogueHistory = history || 'нет'

    const systemPrompt = [
        IRM_BASE,
        '',
        patientContext,
        `Сегодня: ${formatToday()}`,
        '',
        'История диалога (обязательно учитывай её при ответе):',
        dialogueHistory,
        '',
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
            { model: 'openai/gpt-4o-mini', temperature: 0.3, max_tokens: 600 }
        )
        return result.content.trim()
    } catch {
        return accumulatedContent[0] || 'Извините, не удалось сформировать ответ.'
    }
}
