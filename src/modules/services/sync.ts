import { eq, and } from 'drizzle-orm'

import { db } from '../../db/client'
import { services } from '../../db/schema'
import { env } from '../../config/constants'
import { BRANCHES } from '../../constants/branches'

const API_BASE = env.EXTERNAL_API_BASE_URL || 'https://rk.etl.uzun.kz/api/v1'

// Прайс-листы для иностранных граждан называются по-разному в разных филиалах
// ("Прайс нерезиденты ...", "... (Иностранцы)", "Прайс СНГ нерезиденты ...",
// "Прайс Средней Азии и РФ ... нерезиденты"), поэтому классифицируем по ключевым
// словам вместо жёсткой подстроки. Всё остальное считаем прайсом для граждан РК.
const FOREIGN_PRICE_LIST_MARKERS = /нерезидент|иностран|снг/i

function classifyCitizenship(priceListName: string): 'kz' | 'foreign' {
    return FOREIGN_PRICE_LIST_MARKERS.test(priceListName) ? 'foreign' : 'kz'
}

interface PriceList {
    ref1cId: string
    name: string
    code: string
    branchRef1cId: string
}

interface PriceListsResponse {
    success: boolean
    data?: {
        priceLists: PriceList[]
        pagination: { total: number }
    }
}

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
    let added = 0
    let updated = 0

    const allItems: FlatServiceItem[] = []

    for (const branch of BRANCHES) {
        // Не фильтруем по search — названия основных прайс-листов не единообразны
        // между филиалами (например, у Шымкента список называется "ИРМ Шымкент",
        // без слова "Основной"). Забираем все прайс-листы филиала и классифицируем
        // их по гражданству локально.
        const priceListsRes = await fetch(
            `${API_BASE}/price-lists?branchId=${branch.ref1cId}&limit=100`,
            {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(15000)
            }
        )

        if (!priceListsRes.ok) {
            continue
        }

        const priceListsData = (await priceListsRes.json()) as PriceListsResponse
        if (!priceListsData.success || !priceListsData.data?.priceLists?.length) {
            continue
        }

        for (const pl of priceListsData.data.priceLists) {
            const citizenship = classifyCitizenship(pl.name)

            const treeRes = await fetch(
                `${API_BASE}/medical-services/tree?priceListId=${pl.ref1cId}`,
                {
                    headers: { Accept: 'application/json' },
                    signal: AbortSignal.timeout(15000)
                }
            )

            if (!treeRes.ok) continue

            const treeData = (await treeRes.json()) as ServicesTreeResponse
            if (!treeData.success || !treeData.data) continue

            const flat = flattenTree(treeData.data, null, pl.branchRef1cId, pl.ref1cId, citizenship)
            allItems.push(...flat)
        }
    }

    for (const item of allItems) {
        const existing = await db
            .select({ id: services.id })
            .from(services)
            .where(
                and(
                    eq(services.ref1cId, item.ref1cId),
                    eq(services.priceListId, item.priceListId)
                )
            )
            .then((rows) => rows[0])

        if (existing) {
            await db
                .update(services)
                .set({
                    name: item.name,
                    price: item.price != null ? String(item.price) : null,
                    durationMinutes: item.durationMinutes,
                    parentRef1cId: item.parentRef1cId,
                    branchRef1cId: item.branchRef1cId,
                    citizenship: item.citizenship,
                    updatedAt: new Date()
                })
                .where(eq(services.id, existing.id))
            updated++
        } else {
            await db.insert(services).values({
                ref1cId: item.ref1cId,
                name: item.name,
                price: item.price != null ? String(item.price) : null,
                durationMinutes: item.durationMinutes,
                parentRef1cId: item.parentRef1cId,
                branchRef1cId: item.branchRef1cId,
                priceListId: item.priceListId,
                citizenship: item.citizenship
            })
            added++
        }
    }

    return { added, updated, total: allItems.length }
}
