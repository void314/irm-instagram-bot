import { and, asc, eq, gte, ilike, isNotNull, or } from 'drizzle-orm'

import { findBranchByNameOrCity, getBranchesList } from '../../constants/branches'
import { db } from '../../db/client'
import { services } from '../../db/schema'
import { chat } from '../llm/openrouter'
import { log } from '../logger'
import type { Tool, ToolResult } from './types'

const PRICE_MARKERS = /(цен|стоимост|прайс|тариф|поч[её]м|сколько|сколко)/i
const PRICE_TOKEN_RE =
    /^(цен|цена|цены|ценник|стоимост|стоимость|прайс|прайслист|тариф|поче?м|сколько|сколко|сто[ия][тм]ь?|услуг|услуга|услуги)$/i
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
    const v = String(value ?? '')
        .trim()
        .toLowerCase()
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

// Символические/технические цены в 1С (0, 1, 120 тенге) встречаются у части
// позиций (тестовые/служебные строки) — отсекаем их, чтобы не показывать
// пациенту нерепрезентативную "цену".
const MIN_PLAUSIBLE_PRICE = '1000'

interface CategoryRow {
    category: string
    name: string
    price: string | null
    durationMinutes: number | null
}

/**
 * Возвращает по одной репрезентативной (самой дешёвой) услуге на каждую
 * категорию услуг филиала/гражданства. Категории — фиксированная таксономия
 * (см. src/constants/service-categories.ts), проставленная один раз при
 * синхронизации каталога через LLM-классификатор, а не на каждый запрос.
 * Благодаря этому здесь всего один дешёвый SQL-запрос (DISTINCT ON) вместо
 * перебора сотен-тысяч строк услуг на каждое сообщение пользователя.
 */
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

const CATEGORY_SUMMARY_SYSTEM_PROMPT: Record<'ru' | 'kk' | 'en', string> = {
    ru: `Ты — Айгерим, консультант клиники репродуктивного здоровья IRM Clinic.
Пользователь спросил про цены на услуги в общем (без указания конкретной услуги).
Тебе дан JSON-список категорий услуг с ценой на самую доступную услугу в каждой категории.

Напиши тёплый, естественный ответ на русском языке (не маркированный список, а связный текст),
который:
- кратко упомянет несколько категорий с ориентировочными ценами ("от X ₸"),
- явно скажет, что это только часть услуг клиники и полный перечень значительно шире,
- закончится вопросом, что именно интересует пользователя (например: подготовка к беременности,
  диагностика, конкретная услуга), чтобы дать точную цену.

Используй ТОЛЬКО цифры из предоставленных данных, не придумывай цены и услуги.
Будь краткой (4-6 предложений).`,
    kk: `Сен — Айгерим, IRM Clinic репродуктивті денсаулық клиникасының консультанты.
Пайдаланушы қызметтердің құны туралы жалпы сұрақ қойды (нақты қызметті көрсетпей).
Саған әр санаттағы ең қолжетімді қызметтің бағасы бар JSON тізім берілген.

Қазақ тілінде жылы, табиғи жауап жаз (маркерлі тізім емес, тұтас мәтін):
- бірнеше санатты шамамен бағамен ("X ₸-ден") қысқаша атап өт,
- бұл клиниканың қызметтерінің тек бір бөлігі екенін және толық тізімнің әлдеқайда
  кең екенін анық айт,
- нақты баға беру үшін пайдаланушыны нені қалайтынын сұрап аяқта.

Тек берілген деректердегі сандарды ғана қолдан, бағаларды немесе қызметтерді ойлап шығарма.
Қысқа бол (4-6 сөйлем).`,
    en: `You are Aigerim, a consultant at IRM Clinic (reproductive health clinic).
The user asked a general question about service prices (without naming a specific service).
You are given a JSON list of service categories with the price of the cheapest service in each.

Write a warm, natural answer in English (flowing text, not a bullet list) that:
- briefly mentions a few categories with approximate prices ("from X tenge"),
- explicitly states this is only part of the clinic's services and the full list is much wider,
- ends with a question asking what specifically interests the user, so you can give an exact price.

Use ONLY the numbers from the provided data, do not invent prices or services.
Be concise (4-6 sentences).`
}

async function formatCategorySummaryWithLLM(rows: CategoryRow[], lang: 'ru' | 'kk' | 'en'): Promise<string> {
    const payload = rows.map((r) => ({
        category: r.category,
        example: r.name,
        priceFrom: r.price ? Number(r.price) : null,
        durationMinutes: r.durationMinutes
    }))

    try {
        const result = await chat(
            [
                {
                    role: 'system',
                    content: CATEGORY_SUMMARY_SYSTEM_PROMPT[lang] || CATEGORY_SUMMARY_SYSTEM_PROMPT.ru
                },
                { role: 'user', content: JSON.stringify(payload) }
            ],
            { model: 'openai/gpt-4o-mini', temperature: 0.4, max_tokens: 400 }
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

// Согласно скрипту колл-центра (format.md): после любого ответа про стоимость
// нужно мягко предложить запись на консультацию. Делаем это детерминированно
// (не полагаясь на то, что LLM-форматирование каждый раз само вспомнит об этом),
// чтобы правило соблюдалось гарантированно.
const BOOKING_CTA: Record<'ru' | 'kk' | 'en', string> = {
    ru: 'Хотите, я запишу Вас на консультацию к врачу? Так Вы получите точную стоимость и подходящую именно Вам программу.',
    kk: 'Дәрігердің кеңесіне жазып қоюымды қалайсыз ба? Осылай сіз нақты құн мен өзіңізге сай бағдарламаны біле аласыз.',
    en: 'Would you like me to book you for a doctor consultation? That way you will get an exact price and a program tailored to you.'
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
        const lang: 'ru' | 'kk' | 'en' = args.lang === 'kk' || args.lang === 'en' ? args.lang : 'ru'

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
            const categoryRows = await getCategorySummary(resolvedBranchRef, citizenship)
            if (categoryRows.length === 0) {
                return {
                    success: true,
                    answer:
                        'К сожалению, я не нашла информации о ценах. ' +
                        'Рекомендую записаться на консультацию врача, где Вам подробно расскажут о стоимости программ.'
                }
            }

            const summary = await formatCategorySummaryWithLLM(categoryRows, lang)
            return { success: true, answer: `${summary}\n\n${BOOKING_CTA[lang]}` }
        }

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
                    eq(services.branchRef1cId, resolvedBranchRef),
                    eq(services.citizenship, citizenship),
                    or(...conditions)
                )
            )
            .limit(MAX_RESULTS * 5)

        const rows = dedupeByNameAndPrice(rawRows).slice(0, MAX_RESULTS)

        if (rows.length === 0 && PRICE_MARKERS.test(query)) {
            const categoryRows = await getCategorySummary(resolvedBranchRef, citizenship)
            if (categoryRows.length === 0) {
                return {
                    success: true,
                    answer:
                        'К сожалению, я не нашла информации о ценах. ' +
                        'Рекомендую записаться на консультацию врача, где Вам подробно расскажут о стоимости программ.'
                }
            }

            const summary = await formatCategorySummaryWithLLM(categoryRows, lang)
            return {
                success: true,
                answer: `Не нашла точное совпадение по услуге. ${summary}\n\n${BOOKING_CTA[lang]}`
            }
        }

        if (rows.length === 0) {
            return {
                success: true,
                answer: `По Вашему запросу ничего не найдено. Попробуйте сформулировать иначе, либо подходящую услугу поможет подобрать врач на консультации.\n\n${BOOKING_CTA[lang]}`
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
            answer: `${header}\n${lines.join('\n')}\n\nОкончательную стоимость и необходимый объём услуг определяет врач на приёме.\n\n${BOOKING_CTA[lang]}`
        }
    }
}
