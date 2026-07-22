import { and, asc, eq, gte, ilike, isNotNull, or } from 'drizzle-orm'

import { env } from '../../config/constants'
import { buildBranchClarificationPrompt, findBranchByNameOrCity } from '../../constants/branches'
import { hasOwnPriceList, resolveFallbackBranchRef1cId } from '../../constants/priceLists'
import { db } from '../../db/client'
import { services } from '../../db/schema'
import { chat } from '../llm/openrouter'
import { log } from '../logger'
import type { Tool, ToolResult } from './types'

const MAX_RESULTS = 20

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2)
}

function normalizeCitizenship(value: unknown): 'kz' | 'foreign' | null {
    const v = String(value ?? '')
        .trim()
        .toLowerCase()
    if (['kz', 'рк', 'кз', 'қз', 'казахстан', 'қазақстан', 'kazakhstan', 'резидент', 'resident'].includes(v))
        return 'kz'
    if (['foreign', 'иностранец', 'иностранный', 'шетел', 'нерезидент', 'non-resident', 'nonresident'].includes(v))
        return 'foreign'
    return null
}

interface PriceRow {
    name: string
    price: string | null
    durationMinutes: number | null
}

function dedupeByNameAndPrice(rows: PriceRow[]): PriceRow[] {
    const seen = new Set<string>()
    const result: PriceRow[] = []
    for (const row of rows) {
        const key = `${row.name.trim().toLowerCase()}|${row.price ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        result.push(row)
    }
    return result
}

const MIN_PLAUSIBLE_PRICE = '1000'

interface CategoryRow {
    category: string
    name: string
    price: string | null
    durationMinutes: number | null
}

async function getCategorySummary(branchRef: string, citizenship: 'kz' | 'foreign'): Promise<CategoryRow[]> {
    const rows = await db
        .selectDistinctOn([services.category], {
            category: services.category,
            name: services.name,
            price: services.price,
            durationMinutes: services.durationMinutes
        })
        .from(services)
        .where(
            and(
                eq(services.branchRef1cId, branchRef),
                eq(services.citizenship, citizenship),
                isNotNull(services.category),
                isNotNull(services.price),
                gte(services.price, MIN_PLAUSIBLE_PRICE)
            )
        )
        .orderBy(services.category, asc(services.price))

    return rows.filter((r): r is CategoryRow => r.category !== null)
}

const CATEGORY_SUMMARY_SYSTEM_PROMPT = `Ты — модуль извлечения данных клиники IRM.
Тебе дан JSON-список категорий медицинских услуг с ценой на самую доступную услугу в каждой категории.
Твой текст НЕ увидит пациент напрямую — его переработает главный агент. Поэтому:
- перечисли категории с ориентировочными ценами ("от X ₸"),
- укажи, что это только часть услуг клиники и полный перечень значительно шире,
- НЕ задавай вопросов пользователю, НЕ обращайся к нему напрямую, НЕ добавляй вежливых фраз.
Используй ТОЛЬКО цифры из предоставленных данных, не придумывай цены и услуги.
Будь краток.`

async function formatCategorySummaryWithLLM(rows: CategoryRow[], lang: 'ru' | 'kk' | 'en'): Promise<string> {
    const payload = rows.map((r) => ({
        category: r.category,
        example: r.name,
        priceFrom: r.price ? Number(r.price) : null,
        durationMinutes: r.durationMinutes
    }))

    const langLabel: Record<string, string> = {
        ru: 'русском',
        kk: 'казахском',
        en: 'английском'
    }
    const systemPrompt = `Твой ответ должен быть на ${langLabel[lang] || 'русском'} языке.\n\n${CATEGORY_SUMMARY_SYSTEM_PROMPT}`

    try {
        const result = await chat(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: JSON.stringify(payload) }
            ],
            { model: env.INTENT_MODEL, temperature: 0.4, max_tokens: 400 }
        )
        return result.content.trim()
    } catch (err) {
        log.warn({ module: 'tools', tool: 'prices', error: String(err) }, 'Category summary LLM formatting failed')

        const lines = rows.map((r) => {
            const price = r.price ? `${Number(r.price).toLocaleString('ru-RU')} ₸` : 'уточните на приёме'
            return `- ${r.category} (напр. ${r.name}) — от ${price}`
        })
        return `Базовый перечень услуг и цен:\n${lines.join('\n')}\n\nЭто лишь часть услуг клиники — уточните, что именно Вас интересует.`
    }
}

export const pricesTool: Tool = {
    name: 'prices',

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const query = String(args.query ?? '').trim()
        const branchRef = String(args.branch_ref1c_id ?? '').trim()
        const branchName = String(args.branch_name ?? '').trim()
        const citizenship = normalizeCitizenship(args.citizenship)
        const lang: 'ru' | 'kk' | 'en' = args.lang === 'kk' || args.lang === 'en' ? args.lang : 'ru'

        const tokens = tokenize(query)
        log.info({ module: 'tools', tool: 'prices', tokens, citizenship }, 'price lookup')

        if (tokens.length === 0) {
            return { success: true, answer: 'Уточните, пожалуйста, какую услугу Вы ищете.', found: false }
        }

        let resolvedBranchRef = branchRef
        if (!resolvedBranchRef && branchName) {
            const branch = findBranchByNameOrCity(branchName)
            if (branch) resolvedBranchRef = branch.ref1cId
        }

        if (!resolvedBranchRef) {
            return {
                success: true,
                answer: buildBranchClarificationPrompt(branchName),
                found: false
            }
        }

        if (!citizenship) {
            return {
                success: true,
                answer: 'Подскажите, пожалуйста, Ваше гражданство (гражданин РК или иностранный гражданин) — стоимость услуг отличается.',
                found: false
            }
        }

        // У некоторых филиалов нет собственного прайс-листа под это гражданство
        // (например, у IRM Кабанбай нет "основного"/kz списка, у IRM Костанай нет
        // "нерезидент" списка) — в этом случае используем прайс IRM Алматы.
        const hasOwn = hasOwnPriceList(resolvedBranchRef, citizenship)
        const queryBranchRef = hasOwn ? resolvedBranchRef : resolveFallbackBranchRef1cId()
        const usedFallbackBranch = queryBranchRef !== resolvedBranchRef
        const fallbackNote = usedFallbackBranch
            ? '\n\n(У этого филиала нет отдельного прайс-листа для этой категории — показаны цены головного филиала IRM Алматы.)'
            : ''

        // Try matching tokens against DB service names
        const conditions = tokens.map((token) => ilike(services.name, `%${token}%`))

        const rawRows = await db
            .select({
                name: services.name,
                price: services.price,
                durationMinutes: services.durationMinutes
            })
            .from(services)
            .where(
                and(
                    eq(services.branchRef1cId, queryBranchRef),
                    eq(services.citizenship, citizenship),
                    or(...conditions)
                )
            )
            .limit(MAX_RESULTS * 5)

        const rows = dedupeByNameAndPrice(rawRows).slice(0, MAX_RESULTS)

        if (rows.length > 0) {
            const lines = rows.map((r) => {
                const price = r.price ? `${Number(r.price).toLocaleString('ru-RU')} ₸` : 'цена уточняется'
                const duration = r.durationMinutes ? ` (${r.durationMinutes} мин)` : ''
                return `- ${r.name} — ${price}${duration}`
            })

            const header = rows.length === 1 ? 'Нашла:' : `Нашла несколько вариантов:`

            return {
                success: true,
                answer: `${header}\n${lines.join('\n')}${fallbackNote}`,
                found: true
            }
        }

        // No matches — show category summary as fallback
        const categoryRows = await getCategorySummary(queryBranchRef, citizenship)
        if (categoryRows.length === 0) {
            return {
                success: true,
                answer:
                    'К сожалению, я не нашла информации о ценах. ' +
                    'Рекомендую записаться на консультацию врача, где Вам подробно расскажут о стоимости программ.',
                found: false
            }
        }

        const summary = await formatCategorySummaryWithLLM(categoryRows, lang)
        return {
            success: true,
            answer: `${summary}${fallbackNote}`,
            found: true
        }
    }
}
