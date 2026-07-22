// Карта "основной"/"нерезидент" прайс-лист на филиал.
//
// ПОЧЕМУ ЖЁСТКАЯ КАРТА, А НЕ ПОИСК ПО ИМЕНИ: у каждого филиала в 1С десятки
// прайс-листов (программы лечения, пакеты, устаревшие СНГ-версии и т.д.), но
// названия "основного" списка НЕ единообразны между филиалами:
//   - IRM Алматы:   "Основной прейскурант ИРМ"
//   - IRM Астана:   "Основной прейскурант ИРМ АСТАНА"
//   - IRM Шымкент:  "ИРМ Шымкент" (без слова "Основной" вообще)
//   - IRM Костанай: "Основной прайс ИРМ КОСТАНАЙ"
// ETL API (rk.etl.uzun.kz) также не возвращает флаг "помечен на удаление" —
// поэтому единственный надёжный способ определить нужный список — явно
// зафиксировать его ref1cId вручную (сверено с бизнесом).
//
// У IRM Кабанбай нет своего "основного" (kz) списка, у IRM Костанай нет своего
// "нерезидент" списка — для этих случаев используется fallback на IRM Алматы
// (см. hasOwnPriceList/resolveFallbackBranchRef1cId, применяется во время
// запроса цен в services/tools/prices.ts, а не при синке).

export const ALMATY_REF1C_ID = '8f601a57fb23c04011ecb4ba67b1ec9c'

export interface BranchPriceListMapping {
    branchRef1cId: string
    /** ref1cId прайс-листа для граждан РК. null — у филиала своего нет, нужен fallback. */
    mainPriceListRef1cId: string | null
    /** ref1cId прайс-листа для иностранных граждан. null — у филиала своего нет, нужен fallback. */
    foreignPriceListRef1cId: string | null
}

export const BRANCH_PRICE_LISTS: BranchPriceListMapping[] = [
    {
        // IRM Костанай
        branchRef1cId: '91201a57fb23c04011ef7b20b28831a2',
        mainPriceListRef1cId: '91201a57fb23c04011ef7b213ab02b8e', // "Основной прайс ИРМ КОСТАНАЙ"
        foreignPriceListRef1cId: null
    },
    {
        // IRM Кабанбай
        branchRef1cId: '8f601a57fb23c04011ecc07f2837df60',
        mainPriceListRef1cId: null,
        foreignPriceListRef1cId: '80551a57fb23c04011ef1ce98965989a' // "Прайс нерезиденты Кабанбай батыра"
    },
    {
        // IRM Алматы (fallback-источник для филиалов без своего списка)
        branchRef1cId: ALMATY_REF1C_ID,
        mainPriceListRef1cId: '8f601a57fb23c04011ecb4ba67a46220', // "Основной прейскурант ИРМ"
        foreignPriceListRef1cId: '9d3b1a57fb23c04011ef18e55aadf7d4' // "Прайс нерезиденты Толе би"
    },
    {
        // IRM Шымкент
        branchRef1cId: '8f601a57fb23c04011ecc07e673b1d18',
        mainPriceListRef1cId: '8cf31a57fb23c04011ee5377cd553a56', // "ИРМ Шымкент"
        foreignPriceListRef1cId: '9bc01a57fb23c04011ef1fc7df212cfa' // "Прайс нерезиденты Шымкент"
    },
    {
        // IRM Астана
        branchRef1cId: '8c321a57fb23c04011eed5573c72c3d4',
        mainPriceListRef1cId: '9ebb1a57fb23c04011ef28956ef6855c', // "Основной прейскурант ИРМ АСТАНА"
        foreignPriceListRef1cId: '86081a57fb23c04011f10192b95a6122' // "Прайс нерезиденты ИРМ АСТАНА"
    }
]

function findMapping(branchRef1cId: string): BranchPriceListMapping | undefined {
    return BRANCH_PRICE_LISTS.find((b) => b.branchRef1cId === branchRef1cId)
}

/**
 * Список (branch, citizenship, priceListId) только для реально существующих
 * у филиала списков — используется синком (sync.ts), чтобы тянуть ровно один
 * прайс-лист на пару (филиал, гражданство), а не все прайс-листы филиала.
 */
export function getOwnedPriceLists(): {
    branchRef1cId: string
    citizenship: 'kz' | 'foreign'
    priceListId: string
}[] {
    const result: { branchRef1cId: string; citizenship: 'kz' | 'foreign'; priceListId: string }[] = []

    for (const mapping of BRANCH_PRICE_LISTS) {
        if (mapping.mainPriceListRef1cId) {
            result.push({
                branchRef1cId: mapping.branchRef1cId,
                citizenship: 'kz',
                priceListId: mapping.mainPriceListRef1cId
            })
        }
        if (mapping.foreignPriceListRef1cId) {
            result.push({
                branchRef1cId: mapping.branchRef1cId,
                citizenship: 'foreign',
                priceListId: mapping.foreignPriceListRef1cId
            })
        }
    }

    return result
}

/** Есть ли у филиала собственный прайс-лист для данного гражданства. */
export function hasOwnPriceList(branchRef1cId: string, citizenship: 'kz' | 'foreign'): boolean {
    const mapping = findMapping(branchRef1cId)
    if (!mapping) return false
    return citizenship === 'kz' ? !!mapping.mainPriceListRef1cId : !!mapping.foreignPriceListRef1cId
}

/** Филиал, чьи цены нужно использовать, если у запрошенного своего списка нет. Всегда IRM Алматы. */
export function resolveFallbackBranchRef1cId(): string {
    return ALMATY_REF1C_ID
}
