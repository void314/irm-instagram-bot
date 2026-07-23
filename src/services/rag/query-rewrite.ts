import { env } from '../../config/constants'
import { chat } from '../llm/openrouter'
import { log } from '../logger'

const EXPANDER_MODEL = env.LLM_MODEL

const PRONOUN_MARKERS = [
    // Russian
    'он',
    'она',
    'оно',
    'они',
    'его',
    'её',
    'ee',
    'их',
    'это',
    'эти',
    'этот',
    'эта',
    'этом',
    'этому',
    'там',
    'тут',
    'здесь',
    'оттуда',
    'такой',
    'такая',
    'такие',
    'такого',
    'таком',
    'сколько',
    'столько',
    'настолько',
    'у них',
    'у него',
    'у неё',
    'у нее',
    'про него',
    'про неё',
    'про нее',
    'про них',
    'о нём',
    'о нем',
    'о ней',
    'о них',
    'а у',
    'а для',
    'а с',
    'что по',
    'а что',
    'а как',
    'а когда',
    'а где',
    'какие',
    'какой',
    'какая',
    'какое',
    'почём',
    'расценк',
    'стоимост',
    // English
    'he',
    'she',
    'it',
    'they',
    'him',
    'her',
    'his',
    'its',
    'their',
    'them',
    'this',
    'that',
    'these',
    'those',
    'there',
    'here',
    'what about',
    'how about',
    'tell me more',
    // Kazakh
    'ол',
    'оның',
    'оған',
    'оны',
    'онда',
    'одан',
    'бұл',
    'сол',
    'осы',
    'анау',
    'мынау',
    'сонда',
    'мұнда',
    'осында',
    'қанша',
    'неше',
    'қалай',
    'қайда'
]

function needsRewrite(query: string, history: { role: string; content: string }[]): boolean {
    if (history.length === 0) return false
    const words = query.trim().split(/\s+/)
    if (words.length > 10) return false
    const lower = query.toLowerCase()
    if (PRONOUN_MARKERS.some((m) => lower.includes(m))) return true
    if (words.length <= 4) return true
    return false
}

async function expandQuery(
    query: string,
    history: { role: 'user' | 'assistant'; content: string }[]
): Promise<string> {
    const historyBlock = history
        .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`)
        .join('\n')

    const prompt = `Given the conversation history and the latest user query, rewrite the query as a standalone search query for a medical clinic knowledge base. Include all relevant context from the conversation. Output ONLY the search query text, nothing else.

History:
${historyBlock}

Latest query: ${query}

Search query:`

    try {
        const response = await chat([{ role: 'user', content: prompt }], {
            model: EXPANDER_MODEL,
            temperature: 0,
            max_tokens: 80
        })

        const expanded = response.content.trim()
        if (expanded) {
            log.info({ module: 'query-rewrite', original: query, expanded }, 'query expanded')
            return expanded
        }

        return query
    } catch (err) {
        log.warn({ module: 'query-rewrite', error: String(err) }, 'query expander failed')
        return query
    }
}

function dedupeKeepOrder(items: string[]): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of items) {
        const v = item.trim()
        if (!v) continue
        const key = v.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(v)
    }
    return out
}

export async function resolveSearchQueries(
    query: string,
    history: { role: 'user' | 'assistant'; content: string }[]
): Promise<string[]> {
    const lower = query.toLowerCase()
    const extras: string[] = []

    const wantsServices =
        /(?:услуг(?:а|и)?|процедур(?:а|ы)?|направлени(?:е|я)|что\s+делаете|что\s+лечите|какие\s+услуги)/iu.test(
            lower
        )
    if (wantsServices) {
        extras.push('прайс услуги')
        extras.push('список услуг клиники')
    }

    if (!needsRewrite(query, history)) {
        return dedupeKeepOrder([query, ...extras])
    }
    try {
        const rewritten = await expandQuery(query, history)
        return dedupeKeepOrder([query, ...extras, rewritten])
    } catch (err) {
        log.warn({ module: 'query-rewrite', error: String(err) }, 'resolve search queries failed')
        return dedupeKeepOrder([query, ...extras])
    }
}
