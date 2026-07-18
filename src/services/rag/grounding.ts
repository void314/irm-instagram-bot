import { chat } from '../llm/openrouter'
import { SYSTEM_PROMPT_CLARIFICATION } from './prompts'

// Маркеры неуверенности модели на всех трёх языках интерфейса (ru/kk/en).
// Используются только как ДОПОЛНИТЕЛЬНЫЙ сигнал — основной, детерминированный
// критерий ниже это порог релевантности (score), а не текст ответа.
const AMBIGUITY_PHRASES = [
    // ru
    'не могу ответить',
    'не хватает информации',
    'нет в контексте',
    'не нашел',
    'не нашла',
    'уточните',
    'не знаю',
    'недостаточно информации',
    // kk
    'жауап бере алмаймын',
    'ақпарат жеткіліксіз',
    'білмеймін',
    'нақтылаңызшы',
    // en
    "don't know",
    'not enough information',
    'cannot answer',
    "i'm not sure",
    'please clarify'
]

const SCORE_THRESHOLD = 0.25

function containsAmbiguity(answer: string): boolean {
    const lower = answer.toLowerCase()
    return AMBIGUITY_PHRASES.some((p) => lower.includes(p))
}

export interface GroundingResult {
    passed: boolean
    needsClarification: boolean
    clarificationQuestion?: string
}

export interface ChunkWithScore {
    text: string
    score: number
}

export async function checkGrounding(
    answer: string,
    chunks: ChunkWithScore[],
    query: string
): Promise<GroundingResult> {
    if (chunks.length === 0) {
        return { passed: true, needsClarification: false }
    }

    const maxScore = Math.max(...chunks.map((c) => c.score))

    // Раньше при низкой релевантности уточнение запрашивалось ТОЛЬКО если сам текст
    // ответа содержал одну из русскоязычных фраз-маркеров ("не хватает информации" и
    // т.п.). Из-за этого уверенно сформулированная галлюцинация на низкой релевантности
    // (или ответ на казахском/английском) проходила проверку необнаруженной.
    // Теперь низкий score — самостоятельное, детерминированное основание для уточнения;
    // фразы-маркеры остаются как дополнительный (не единственный) сигнал.
    if (maxScore >= SCORE_THRESHOLD && !containsAmbiguity(answer)) {
        return { passed: true, needsClarification: false }
    }

    return {
        passed: false,
        needsClarification: true,
        clarificationQuestion: await generateClarification(
            query,
            chunks.map((c) => c.text)
        )
    }
}

async function generateClarification(query: string, contextTexts: string[]): Promise<string> {
    const contextPreview = contextTexts
        .map((t) => t.slice(0, 300))
        .join('\n---\n')
        .slice(0, 2000)

    try {
        const response = (
            await chat([
                {
                    role: 'system',
                    content: SYSTEM_PROMPT_CLARIFICATION.replace('{context}', contextPreview)
                },
                {
                    role: 'user',
                    content: `Вопрос пользователя: ${query}`
                }
            ])
        ).content

        return response || 'Не могли бы вы уточнить ваш вопрос? Мне не хватает информации для полного ответа.'
    } catch {
        return 'Не могли бы вы уточнить ваш вопрос? Мне не хватает информации для полного ответа.'
    }
}
