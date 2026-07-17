import { chat } from '../llm/openrouter'
import { SYSTEM_PROMPT_CLARIFICATION } from './prompts'

const AMBIGUITY_PHRASES = [
    'не могу ответить',
    'не хватает информации',
    'нет в контексте',
    'не нашел',
    'уточните',
    'не знаю'
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

    if (maxScore >= SCORE_THRESHOLD) {
        return { passed: true, needsClarification: false }
    }

    if (containsAmbiguity(answer)) {
        return {
            passed: false,
            needsClarification: true,
            clarificationQuestion: await generateClarification(query, chunks.map((c) => c.text))
        }
    }

    return { passed: true, needsClarification: false }
}

async function generateClarification(query: string, contextTexts: string[]): Promise<string> {
    const contextPreview = contextTexts.map((t) => t.slice(0, 300)).join('\n---\n').slice(0, 2000)

    try {
        const response = await chat([
            {
                role: 'system',
                content: SYSTEM_PROMPT_CLARIFICATION.replace('{context}', contextPreview)
            },
            {
                role: 'user',
                content: `Вопрос пользователя: ${query}`
            }
        ])

        return response || 'Не могли бы вы уточнить ваш вопрос? Мне не хватает информации для полного ответа.'
    } catch {
        return 'Не могли бы вы уточнить ваш вопрос? Мне не хватает информации для полного ответа.'
    }
}
