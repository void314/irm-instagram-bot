import { and, eq, ilike, or } from 'drizzle-orm'

import { db } from '../../db/client'
import { services } from '../../db/schema'
import { log } from '../logger'
import { findBranchByNameOrCity, getBranchesList } from '../../constants/branches'
import type { Tool, ToolResult } from './types'

const PRICE_MARKERS = /(цен|стоимост|прайс|тариф|поч[её]м|сколько|сколко)/i
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
            const rawFallback = await db
                .select({
                    name: services.name,
                    price: services.price,
                    durationMinutes: services.durationMinutes
                })
                .from(services)
                .where(
                    and(
                        eq(services.branchRef1cId, resolvedBranchRef),
                        eq(services.citizenship, citizenship)
                    )
                )
                .limit(50)

            const fallback = dedupeByNameAndPrice(rawFallback).slice(0, 10)

            if (fallback.length === 0) {
                return {
                    success: true,
                    answer:
                        'К сожалению, я не нашла информации о ценах. ' +
                        'Рекомендую записаться на консультацию врача, где Вам подробно расскажут о стоимости программ.'
                }
            }

            const lines = fallback.map((r) => {
                const price = r.price ? `${Number(r.price).toLocaleString('ru-RU')} ₸` : 'уточните на приёме'
                const duration = r.durationMinutes ? ` (${r.durationMinutes} мин)` : ''
                return `- ${r.name} — ${price}${duration}`
            })

            return {
                success: true,
                answer: `Вот основные услуги клиники:\n${lines.join('\n')}\n\nЧтобы уточнить конкретную услугу, напишите её название.`
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
