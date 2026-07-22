export interface Branch {
    name: string
    city: string
    ref1cId: string
}

// ВАЖНО: ref1cId ниже — это ref1cId филиала из внешнего API (rk.etl.uzun.kz),
// именно это значение используется как branchRef1cId в таблице services, у докторов
// и в price-lists. Не путать с внутренним id филиала (cuid) — они выглядят похоже,
// но это разные идентификаторы. Проверено вручную через GET /api/v1/branches.
export const BRANCHES: Branch[] = [
    { name: 'IRM Костанай', city: 'Костанай', ref1cId: '91201a57fb23c04011ef7b20b28831a2' },
    { name: 'IRM Кабанбай', city: 'Алматы', ref1cId: '8f601a57fb23c04011ecc07f2837df60' },
    { name: 'IRM Алматы', city: 'Алматы', ref1cId: '8f601a57fb23c04011ecb4ba67b1ec9c' },
    { name: 'IRM Шымкент', city: 'Шымкент', ref1cId: '8f601a57fb23c04011ecc07e673b1d18' },
    { name: 'IRM Астана', city: 'Астана', ref1cId: '8c321a57fb23c04011eed5573c72c3d4' },
    { name: 'IRM Кызылорда', city: 'Кызылорда', ref1cId: '939c1a57fb23c04011f1662d0e0410f2' }
]

// Возвращает конкретный филиал только если запрос ОДНОЗНАЧНО указывает на один
// филиал. Точное совпадение с полным названием всегда однозначно (даже если
// оно пересекается по городу с другим филиалом). Частичное совпадение по имени
// ИЛИ городу допустимо, только если оно нашло РОВНО один филиал — если совпало
// несколько (например, "Алматы" одновременно частично совпадает и с названием
// IRM Алматы, и с городом IRM Кабанбай), намеренно возвращаем null, чтобы
// вызывающий код переспросил пациента, а не угадывал первый попавшийся филиал.
export function findBranchByNameOrCity(input: string): Branch | null {
    const q = input.toLowerCase().trim()
    if (!q) return null

    const exactName = BRANCHES.find((b) => b.name.toLowerCase() === q)
    if (exactName) return exactName

    const candidates = BRANCHES.filter((b) => b.name.toLowerCase().includes(q) || b.city.toLowerCase().includes(q))

    return candidates.length === 1 ? candidates[0] : null
}

// Список филиалов, которые частично совпадают с запросом, но неоднозначно
// (более одного кандидата) — используется вызывающим кодом, чтобы задать
// пациенту точечный уточняющий вопрос вместо показа всего списка филиалов.
export function findAmbiguousBranches(input: string): Branch[] {
    const q = input.toLowerCase().trim()
    if (!q) return []

    const exactName = BRANCHES.some((b) => b.name.toLowerCase() === q)
    if (exactName) return []

    const candidates = BRANCHES.filter((b) => b.name.toLowerCase().includes(q) || b.city.toLowerCase().includes(q))

    return candidates.length > 1 ? candidates : []
}

export function getBranchesList(): string {
    return BRANCHES.map((b) => `- ${b.name} (${b.city})`).join('\n')
}

// Обратный поиск филиала по ref1cId — нужен, когда branch_ref1c_id уже известен
// (например, передан напрямую моделью или из карточки пациента) и нужно только
// красиво отобразить название филиала пациенту.
export function findBranchByRef1cId(ref1cId: string): Branch | null {
    return BRANCHES.find((b) => b.ref1cId === ref1cId) ?? null
}

// Единая точка формирования уточняющего вопроса про филиал: если запрос
// частично совпал с несколькими филиалами (например, "Алматы") — задаём
// точечный вопрос только про эти конкретные варианты, а не показываем
// весь список из всех городов клиники.
export function buildBranchClarificationPrompt(input?: string): string {
    const ambiguous = input ? findAmbiguousBranches(input) : []

    if (ambiguous.length > 0) {
        const options = ambiguous.map((b) => `${b.name} (${b.city})`).join(' или ')
        return `В городе ${ambiguous[0].city} несколько филиалов. Уточните, пожалуйста, какой именно: ${options}?`
    }

    return `Пожалуйста, уточните филиал клиники.\nДоступные филиалы:\n${getBranchesList()}`
}
