import { env } from '../../config/constants'
import { getOwnedPriceLists } from '../../constants/priceLists'
import { db } from '../../db/client'
import { services } from '../../db/schema'
import { log } from '../../services/logger'
import { classifyServiceNames } from './service-classifier'

const API_BASE = env.EXTERNAL_API_BASE_URL || 'https://rk.etl.uzun.kz/api/v1'

// Батч вставки — чтобы не отправлять один INSERT на тысячи строк за раз.
const INSERT_BATCH_SIZE = 500

interface ServiceNode {
    ref1cId: string
    name: string
    price?: number
    durationMinutes?: number
    children?: ServiceNode[]
}

interface ServicesTreeResponse {
    success: boolean
    data?: ServiceNode[]
}

export interface SyncResult {
    added: number
    updated: number
    total: number
}

interface FlatServiceItem {
    ref1cId: string
    name: string
    price: number | null
    durationMinutes: number | null
    parentRef1cId: string | null
    branchRef1cId: string
    priceListId: string
    citizenship: 'kz' | 'foreign'
}

function flattenTree(
    nodes: ServiceNode[],
    parentRef1cId: string | null,
    branchRef1cId: string,
    priceListId: string,
    citizenship: 'kz' | 'foreign'
): FlatServiceItem[] {
    const result: FlatServiceItem[] = []

    for (const node of nodes) {
        result.push({
            ref1cId: node.ref1cId,
            name: node.name,
            price: node.price ?? null,
            durationMinutes: node.durationMinutes ?? null,
            parentRef1cId,
            branchRef1cId,
            priceListId,
            citizenship
        })

        if (node.children && node.children.length > 0) {
            result.push(...flattenTree(node.children, node.ref1cId, branchRef1cId, priceListId, citizenship))
        }
    }

    return result
}

export async function fetchAndUpdateServices(): Promise<SyncResult> {
    const allItems: FlatServiceItem[] = []

    // Тянем РОВНО ОДИН прайс-лист на пару (филиал, гражданство) — тот, что
    // зафиксирован в constants/priceLists.ts. Раньше здесь забирались ВСЕ
    // прайс-листы филиала (программы лечения, устаревшие СНГ-версии и т.д.),
    // из-за чего одна и та же услуга попадала в базу по нескольку раз с разными
    // priceListId и иногда разными ценами — pricesTool.ts фильтрует только по
    // branchRef1cId+citizenship и не знает про priceListId, поэтому пациент видел
    // задвоенные/противоречивые цены.
    for (const owned of getOwnedPriceLists()) {
        try {
            const treeRes = await fetch(`${API_BASE}/medical-services/tree?priceListId=${owned.priceListId}`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(15000)
            })

            if (!treeRes.ok) {
                log.warn(
                    {
                        module: 'services-cron',
                        branchRef1cId: owned.branchRef1cId,
                        priceListId: owned.priceListId
                    },
                    '[ServicesCron] price list fetch failed, skipping'
                )
                continue
            }

            const treeData = (await treeRes.json()) as ServicesTreeResponse
            if (!treeData.success || !treeData.data) continue

            const flat = flattenTree(treeData.data, null, owned.branchRef1cId, owned.priceListId, owned.citizenship)
            allItems.push(...flat)
        } catch (err) {
            log.error(
                { module: 'services-cron', branchRef1cId: owned.branchRef1cId, error: String(err) },
                '[ServicesCron] price list fetch error, skipping'
            )
        }
    }

    // Категоризация делается один раз по уникальным названиям услуг (их на порядок
    // меньше, чем строк allItems), а не на каждую строку — иначе LLM гонялась бы
    // тысячи раз за один синк. Уже классифицированные ранее названия берутся из кеша.
    const categoryMap = await classifyServiceNames(allItems.map((item) => item.name))

    // TRUNCATE + полная вставка вместо upsert-diff: таблица — это просто кеш
    // текущего состояния 1С, перестраивается заново каждый синк (раз в 6 часов).
    // Так нет риска, что строки от исключённых теперь прайс-листов останутся
    // в базе навсегда, и нет race-prone check-then-insert на каждую строку.
    await db.transaction(async (tx) => {
        await tx.delete(services)

        for (let i = 0; i < allItems.length; i += INSERT_BATCH_SIZE) {
            const batch = allItems.slice(i, i + INSERT_BATCH_SIZE)
            if (batch.length === 0) continue

            await tx.insert(services).values(
                batch.map((item) => ({
                    ref1cId: item.ref1cId,
                    name: item.name,
                    price: item.price != null ? String(item.price) : null,
                    durationMinutes: item.durationMinutes,
                    parentRef1cId: item.parentRef1cId,
                    branchRef1cId: item.branchRef1cId,
                    priceListId: item.priceListId,
                    citizenship: item.citizenship,
                    category: categoryMap.get(item.name) ?? null
                }))
            )
        }
    })

    return { added: allItems.length, updated: 0, total: allItems.length }
}
