import { and, eq, ilike, or } from 'drizzle-orm'

import { db } from '../../db/client'
import { services } from '../../db/schema'
import { log } from '../logger'
import { findBranchByNameOrCity, getBranchesList } from '../../constants/branches'
import type { Tool, ToolResult } from './types'

const PRICE_MARKERS = /(цен|стоимост|прайс|тариф|поч[её]м|сколько|сколко)/i
const PRICE_TOKEN_RE = /^(цен|цена|цены|ценник|стоимост|стоимость|прайс|прайслист|тариф|поче?м|сколько|сколко|стоит|стоить|услуг|услуга|услуги)$/i
const STOP_WORDS = new Set(['на', 'по', 'за', 'об', 'для'])
const MAX_RESULTS = 20

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-zа-яё0-9\s]/gi, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2)
}

function normalizeCitizenship(value: unknown): 'kz' | 'foreign' | null {
    const v = String(value ?? '').trim().toLowerCase()
    if (['kz', 'рк', 'kazakhstan', 'казахстан', 'резидент'].includes(v)) return 'kz'
    if (['foreign', 'иностранец', 'иностранный', 'нерезидент', 'non-resident'].includes(v)) return 'foreign'
    return null
}

function isPriceToken(token: string): boolean {
    if (STOP_WORDS.has(token)) return true
    return PRICE_TOKEN_RE.test(token)
}

interface PriceRow {
    name: string
    price: string | null
    durationMinutes: number | null
}

// Один и тот же сервис часто встречается в нескольких прайс-листах одного филиала
// (основной прайс + пакетные прайсы), поэтому убираем дубликаты по названию+цене,
// иначе пользователь получает один и тот же пункт по несколько раз подряд.
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

async function findCheapestByPatterns(
    branchRef: string,
    citizenship: 'kz' | 'foreign',
    patterns: string[]
): Promise<PriceRow | null> {
    if (patterns.length === 0) return null

    const conditions = patterns.map((pattern) => ilike(services.name, `%${pattern}%`))

    const rows = await db
        .select({
            name: services.name,
            price: services.price,
            durationMinutes: services.durationMinutes
        })
        .from(services)
        .where(
            and(
                eq(services.branchRef1cId, branchRef),
                eq(services.citizenship, citizenship),
                or(...conditions)
            )
        )
        .orderBy(services.price)
        .limit(1)

    return rows[0] ?? null
}

async function getBasicPriceList(
    branchRef: string,
    citizenship: 'kz' | 'foreign'
): Promise<PriceRow[]> {
    const categories: Array<{ label: string; patterns: string[] }> = [
        { label: 'Консультация', patterns: ['консультац', 'прием', 'приём'] },
        { label: 'УЗИ', patterns: ['узи'] },
        { label: 'Спермограмма', patterns: ['спермограмм'] },
        { label: 'Гормоны', patterns: ['гормон'] },
        { label: 'Пункция', patterns: ['пункци'] },
        { label: 'Перенос эмбриона', patterns: ['перенос эмбр'] },
        { label: 'Заморозка эмбрионов', patterns: ['замороз', 'крио', 'эмбри'] }
    ]

    const rows: PriceRow[] = []

    for (const category of categories) {
        const row = await findCheapestByPatterns(branchRef, citizenship, category.patterns)
        if (row) rows.push(row)
    }

    const deduped = dedupeByNameAndPrice(rows)
    if (deduped.length > 0) return deduped.slice(0, 10)

    const fallback = await db
        .select({
            name: services.name,
            price: services.price,
            durationMinutes: services.durationMinutes
        })
        .from(services)
        .where(
            and(
                eq(services.branchRef1cId, branchRef),
                eq(services.citizenship, citizenship)
            )
        )
        .orderBy(services.name)
        .limit(10)

    return dedupeByNameAndPrice(fallback)
}

function isGeneralPriceQuery(tokens: string[]): boolean {
    const meaningful = tokens.filter((token) => !isPriceToken(token))
    return meaningful.length === 0
}

export const pricesTool: Tool = {
    name: 'prices',

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const query = String(args.query ?? '').trim()
        const branchRef = String(args.branch_ref1c_id ?? '').trim()
        const branchName = String(args.branch_name ?? '').trim()
        const citizenship = normalizeCitizenship(args.citizenship)

        const tokens = tokenize(query)
        log.info({ module: 'tools', tool: 'prices', tokens, citizenship }, 'price lookup')

        if (tokens.length === 0) {
            return { success: true, answer: 'Уточните, пожалуйста, какую услугу Вы ищете.' }
        }

        let resolvedBranchRef = branchRef
        if (!resolvedBranchRef && branchName) {
            const branch = findBranchByNameOrCity(branchName)
            if (branch) resolvedBranchRef = branch.ref1cId
        }

        if (!resolvedBranchRef) {
            return {
                success: true,
                answer: `Пожалуйста, уточните филиал клиники.\nДоступные филиалы:\n${getBranchesList()}`
            }
        }

        if (!citizenship) {
            return {
                success: true,
                answer: 'Подскажите, пожалуйста, Ваше гражданство (гражданин РК или иностранный гражданин) — стоимость услуг отличается.'
            }
        }

        if (isGeneralPriceQuery(tokens)) {
            const baseList = await getBasicPriceList(resolvedBranchRef, citizenship)
            if (baseList.length === 0) {
                return {
                    success: true,
                    answer:
                        'К сожалению, я не нашла информации о ценах. ' +
                        'Рекомендую записаться на консультацию врача, где Вам подробно расскажут о стоимости программ.'
                }
            }

            const lines = baseList.map((r) => {
                const price = r.price ? `${Number(r.price).toLocaleString('ru-RU')} ₸` : 'уточните на приёме'
                const duration = r.durationMinutes ? ` (${r.durationMinutes} мин)` : ''
                return `- ${r.name} — ${price}${duration}`
            })

            return {
                success: true,
                answer: `Базовый перечень услуг и цен:\n${lines.join('\n')}\n\nЕсли интересует конкретная услуга — напишите её название.`
            }
        }

        const conditions = tokens.map(
            (token) => ilike(services.name, `%${token}%`)
        )

        const rawRows = await db
            .select({
                name: services.name,
                price: services.price,
                durationMinutes: services.durationMinutes
            })
            .from(services)
            .where(
                and(
                    eq(services.branchRef1cId, resolvedBranchRef),
                    eq(services.citizenship, citizenship),
                    or(...conditions)
                )
            )
            .limit(MAX_RESULTS * 5)

        const rows = dedupeByNameAndPrice(rawRows).slice(0, MAX_RESULTS)

        if (rows.length === 0 && PRICE_MARKERS.test(query)) {
            const baseList = await getBasicPriceList(resolvedBranchRef, citizenship)
            if (baseList.length === 0) {
                return {
                    success: true,
                    answer:
                        'К сожалению, я не нашла информации о ценах. ' +
                        'Рекомендую записаться на консультацию врача, где Вам подробно расскажут о стоимости программ.'
                }
            }

            const lines = baseList.map((r) => {
                const price = r.price ? `${Number(r.price).toLocaleString('ru-RU')} ₸` : 'уточните на приёме'
                const duration = r.durationMinutes ? ` (${r.durationMinutes} мин)` : ''
                return `- ${r.name} — ${price}${duration}`
            })

            return {
                success: true,
                answer: `Не нашла точное совпадение по услуге. Вот базовый перечень цен:\n${lines.join('\n')}\n\nЕсли интересует конкретная услуга — напишите её название.`
            }
        }

        if (rows.length === 0) {
            return {
                success: true,
                answer:
                    'По Вашему запросу ничего не найдено. Попробуйте сформулировать иначе или обратитесь к врачу на консультации.'
            }
        }

        const lines = rows.map((r) => {
            const price = r.price ? `${Number(r.price).toLocaleString('ru-RU')} ₸` : 'цена уточняется'
            const duration = r.durationMinutes ? ` (${r.durationMinutes} мин)` : ''
            return `- ${r.name} — ${price}${duration}`
        })

        const header = rows.length === 1 ? 'Нашла:' : `Нашла несколько вариантов:`

        return {
            success: true,
            answer: `${header}\n${lines.join('\n')}\n\nОкончательную стоимость и необходимый объём услуг определяет врач на приёме.`
        }
    }
}
