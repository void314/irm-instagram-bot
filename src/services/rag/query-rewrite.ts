import { env } from '../../config/constants'
import { type ChatMessage, chat } from '../llm/openrouter'
import { log } from '../logger'

const QUERY_ANALYZER_MODEL = env.INTENT_MODEL

interface SearchQueryPlanRaw {
    semanticQuery?: unknown
    supplementalQueries?: unknown
}

export interface ResolvedSearchQueries {
    queries: string[]
    semanticQuery: string
}

const SEARCH_QUERY_ANALYZER_PROMPT = [
    'You optimize retrieval queries for a fertility clinic knowledge base.',
    'Return ONLY valid JSON with EXACTLY these keys and types:',
    '{"semanticQuery": string, "supplementalQueries": string[]}',
    '',
    'Rules:',
    '- semanticQuery: the best standalone search query that preserves the latest user intent.',
    '- If the latest query is already self-contained, keep semanticQuery very close to it.',
    '- supplementalQueries: 0 to 3 additional search queries that improve recall for the same intent.',
    '- Use supplementalQueries only when they add distinct retrieval value, not paraphrase noise.',
    '- Queries may target services, prices, programs, doctors, branches, schedules, tests, or procedures when relevant.',
    '- Do not invent facts that are not present in the conversation.',
    '- Do not output explanations, markdown, or code fences.',
    '- Keep each query short, specific, and suitable for vector or keyword search.',
    '- Avoid duplicates and near-duplicates.',
    '- Prefer wording most likely to match the clinic knowledge base and the conversation context.'
].join('\n')

function extractJsonObject(raw: string): SearchQueryPlanRaw {
    const trimmed = raw.trim()
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (fenced) return JSON.parse(fenced[1].trim()) as SearchQueryPlanRaw

    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as SearchQueryPlanRaw
    }

    return {}
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

function normalizePlan(query: string, raw: SearchQueryPlanRaw): ResolvedSearchQueries {
    const semanticQuery = typeof raw.semanticQuery === 'string' && raw.semanticQuery.trim() ? raw.semanticQuery.trim() : query.trim()
    const supplementalQueries = Array.isArray(raw.supplementalQueries)
        ? raw.supplementalQueries
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim())
              .filter(Boolean)
              .slice(0, 3)
        : []

    return {
        queries: dedupeKeepOrder([query, ...supplementalQueries, semanticQuery]),
        semanticQuery
    }
}

export async function resolveSearchQueries(query: string, history: ChatMessage[]): Promise<ResolvedSearchQueries> {
    try {
        const payload = JSON.stringify({
            latest_query: query,
            history: history.map((message) => ({
                role: message.role,
                content: typeof message.content === 'string' ? message.content : ''
            }))
        })

        let result: { content: string }
        try {
            result = await chat(
                [
                    { role: 'system', content: SEARCH_QUERY_ANALYZER_PROMPT },
                    { role: 'user', content: payload }
                ],
                {
                    model: QUERY_ANALYZER_MODEL,
                    temperature: 0,
                    maxTokens: 220,
                    responseFormat: { type: 'json_object' }
                }
            )
        } catch {
            result = await chat(
                [
                    { role: 'system', content: SEARCH_QUERY_ANALYZER_PROMPT },
                    { role: 'user', content: payload }
                ],
                { model: QUERY_ANALYZER_MODEL, temperature: 0, maxTokens: 260 }
            )
        }

        const parsed = extractJsonObject(result.content)
        const resolved = normalizePlan(query, parsed)
        log.info(
            {
                module: 'query-rewrite',
                original: query,
                semanticQuery: resolved.semanticQuery,
                searchQueries: resolved.queries
            },
            'search query plan resolved'
        )
        return resolved
    } catch (err) {
        log.warn({ module: 'query-rewrite', error: String(err) }, 'resolve search queries failed')
        return { queries: dedupeKeepOrder([query]), semanticQuery: query }
    }
}
