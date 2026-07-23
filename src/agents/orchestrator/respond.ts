import { env } from '../../config/constants'
import { type ChatMessage, chat } from '../../services/llm/openrouter'
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

const LANG_LABEL: Record<'ru' | 'kk' | 'en', string> = {
    ru: 'русском',
    kk: 'казахском',
    en: 'английском'
}

/**
 * Главный агент (Айгерим). В отличие от прежнего "синтезатора", это не редактор,
 * который причёсывает готовые ответы саб-агентов, — это единственная точка, где
 * формируется финальный текст для пациента. Саб-агенты (rag/tool) отдают сюда
 * СЫРЫЕ ФАКТЫ (без тона, приветствий, CTA), а этот агент, имея полный IRM_BASE,
 * историю диалога и данные о пациенте, сам решает, что и как сказать —
 * без повторов и без слепого копирования дублирующихся фрагментов.
 */
export async function craftResponse(
    query: string,
    factFragments: string[],
    lang: 'ru' | 'kk' | 'en',
    patientStr?: string,
    history?: ChatMessage[],
    patientName?: string | null,
    shouldSuggestBooking?: boolean,
    shouldNudgeBooking?: boolean,
    askForName?: boolean
): Promise<string> {
    const extra: string[] = []
    if (patientName) {
        extra.push(
            `Имя пациента: ${patientName}. Используй его в ответе естественно, если это уместно, не форсированно.`
        )
    }
    if (askForName) {
        extra.push(
            'Ты ещё не знаешь имя пациента. ОБЯЗАЛЬНО: В конце ответа вежливо спроси, как к нему обращаться.'
        )
    }
    if (shouldSuggestBooking) {
        extra.push(
            'В конце ответа мягко предложи записаться на консультацию. Сделай это одним естественным предложением.'
        )
    }
    if (shouldNudgeBooking) {
        extra.push(
            'Пациент уже задал несколько вопросов. В конце ответа мягко напомни о возможности записаться на консультацию к врачу.'
        )
    }

    const systemPrompt = [
        IRM_BASE,
        '',
        patientStr || 'Информация о пациенте отсутствует.',
        `Сегодня: ${formatToday()}`,
        '',
        ...(extra.length > 0 ? ['=== ДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ ДЛЯ ЭТОГО ОТВЕТА ===', ...extra, ''] : []),
        '=== ФАКТЫ ОТ СПЕЦИАЛИЗИРОВАННЫХ МОДУЛЕЙ ===',
        'Ниже — сырые факты, собранные внутренними модулями (базой знаний, прайс-листом). Это НЕ готовый ответ,',
        'а материал для тебя. Сформируй из него ОДИН связный ответ от своего лица на ' +
            LANG_LABEL[lang] +
            ' языке, соблюдая все правила выше.',
        'КРИТИЧЕСКИ ВАЖНО:',
        '- Если один и тот же факт (цена, услуга, список филиалов, вопрос) встречается в нескольких фрагментах',
        '  ниже — используй его ТОЛЬКО ОДИН РАЗ, выбрав наиболее полную и точную версию.',
        '- Не придумывай новую информацию, используй только то, что передано в фактах.',
        '- Не упоминай сами модули и структуру данных — говори от своего лица, естественно.',
        '',
        ...factFragments.map((c, i) => `[Факты ${i + 1}]:\n${c}`)
    ].join('\n')

    try {
        const result = await chat(
            [{ role: 'system', content: systemPrompt }, ...(history || []), { role: 'user', content: query }],
            { model: env.SYNTHESIS_MODEL, temperature: 0.3, max_tokens: 800 }
        )
        return result.content.trim()
    } catch {
        return factFragments[0] || 'Извините, не удалось сформировать ответ.'
    }
}
