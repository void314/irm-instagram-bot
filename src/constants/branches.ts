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
    { name: 'IRM Астана', city: 'Астана', ref1cId: '8c321a57fb23c04011eed5573c72c3d4' }
]

export function findBranchByNameOrCity(input: string): Branch | null {
    const q = input.toLowerCase().trim()
    if (!q) return null

    return (
        BRANCHES.find((b) => b.name.toLowerCase().includes(q)) ||
        BRANCHES.find((b) => b.city.toLowerCase().includes(q)) ||
        null
    )
}

export function getBranchesList(): string {
    return BRANCHES.map((b) => `- ${b.name} (${b.city})`).join('\n')
}
