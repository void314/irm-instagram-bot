import { isNotNull } from 'drizzle-orm'

import { env } from '../../config/constants'
import {
    DEFAULT_SERVICE_CATEGORY,
    SERVICE_CATEGORIES,
    isServiceCategory
} from '../../constants/service-categories'
import type { ServiceCategory } from '../../constants/service-categories'
import { db } from '../../db/client'
import { services } from '../../db/schema'
import { chat } from '../../services/llm/openrouter'
import { log } from '../../services/logger'

// Классифицируем услуги ОДИН РАЗ (при синхронизации), а не на каждое сообщение
// пользователя — иначе стоимость LLM была бы неприемлемой (в каталоге клиники
// могут быть тысячи строк услуг на филиал). Классификация делается по УНИКАЛЬНЫМ
// названиям услуг (их на порядок меньше, чем строк в БД, т.к. одно и то же
// название повторяется в разных филиалах/прайс-листах/гражданствах), и
// результат кешируется в колонке services.category — при повторных синхронизациях
// LLM вызывается только для новых, ещё не классифицированных названий.
const BATCH_SIZE = 60

const CLASSIFICATION_PROMPT = `Ты — классификатор медицинских услуг клиники репродуктивного здоровья IRM Clinic.
Тебе дан список названий услуг. Для каждого названия выбери ОДНУ наиболее подходящую категорию
СТРОГО из следующего списка (не придумывай новые категории):

${SERVICE_CATEGORIES.map((c) => `- "${c}"`).join('\n')}

Правила:
- "Консультации врачей" — приёмы/консультации любых специалистов (гинеколог, репродуктолог, уролог, эндокринолог и т.д.)
- "УЗИ и функциональная диагностика" — УЗИ, функциональные исследования
- "Лабораторные анализы" — анализы крови, гормоны, инфекции, мазки, спермограмма и т.п.
- "Генетические исследования" — НИПТ, кариотипирование, ПГТ, генетические панели
- "Программы ВРТ" — ЭКО, ИКСИ, ВМИ, стимуляция овуляции и связанные программы
- "Процедуры и манипуляции" — пункция, перенос эмбриона, заморозка/криоконсервация и другие манипуляции
- "Прочие услуги" — всё, что явно не подходит ни под одну из категорий выше (тренинги, коуч-сессии и т.п.)

Ответь СТРОГО в формате JSON-объекта, где ключ — точное название услуги (как в запросе),
а значение — выбранная категория из списка выше:
{"<название услуги 1>": "<категория>", "<название услуги 2>": "<категория>", ...}`

function chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size))
    }
    return result
}

async function loadCachedCategories(): Promise<Map<string, ServiceCategory>> {
    const rows = await db
        .selectDistinct({ name: services.name, category: services.category })
        .from(services)
        .where(isNotNull(services.category))

    const cache = new Map<string, ServiceCategory>()
    for (const row of rows) {
        if (row.category && isServiceCategory(row.category) && !cache.has(row.name)) {
            cache.set(row.name, row.category)
        }
    }
    return cache
}

async function classifyBatch(names: string[]): Promise<Map<string, ServiceCategory>> {
    const result = new Map<string, ServiceCategory>()

    try {
        const response = await chat(
            [
                { role: 'system', content: CLASSIFICATION_PROMPT },
                { role: 'user', content: JSON.stringify(names) }
            ],
            {
                model: env.INTENT_MODEL,
                temperature: 0,
                max_tokens: 4000,
                response_format: { type: 'json_object' }
            }
        )

        const parsed = JSON.parse(response.content) as Record<string, string>

        for (const name of names) {
            const category = parsed[name]
            result.set(name, isServiceCategory(category) ? category : DEFAULT_SERVICE_CATEGORY)
        }
    } catch (err) {
        log.warn(
            { module: 'service-classifier', error: String(err), batchSize: names.length },
            'Service classification batch failed, falling back to default category'
        )
        for (const name of names) {
            result.set(name, DEFAULT_SERVICE_CATEGORY)
        }
    }

    return result
}

/**
 * Классифицирует уникальные названия услуг по фиксированной таксономии категорий.
 * Использует кеш из уже классифицированных услуг в БД, чтобы не гонять LLM повторно
 * на неизменившиеся названия при каждой синхронизации каталога.
 */
export async function classifyServiceNames(names: string[]): Promise<Map<string, ServiceCategory>> {
    const distinctNames = [...new Set(names)]
    const cache = await loadCachedCategories()

    const toClassify = distinctNames.filter((name) => !cache.has(name))

    if (toClassify.length === 0) {
        log.info(
            { module: 'service-classifier', total: distinctNames.length, cached: cache.size },
            'All service names already categorized'
        )
        return cache
    }

    log.info(
        {
            module: 'service-classifier',
            total: distinctNames.length,
            cached: cache.size,
            toClassify: toClassify.length
        },
        'Classifying new service names via LLM'
    )

    const batches = chunk(toClassify, BATCH_SIZE)
    for (const batch of batches) {
        const classified = await classifyBatch(batch)
        for (const [name, category] of classified) {
            cache.set(name, category)
        }
    }

    return cache
}
