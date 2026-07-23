import { env } from '../../config/constants'
import { log } from '../logger'

export interface MDoctor {
    id: string
    ref1cId: string
    fullName: string
    firstName: string
    lastName: string
    middleName: string
    position: { name?: string; shortName?: string } | string | null
    consultPrice: number
    isCalendarActive: boolean
    department: {
        name: string
        branch: { ref1cId: string; name: string }
    } | null
}

interface DoctorsResponse {
    success: boolean
    data: {
        doctors: MDoctor[]
        pagination: { total: number; limit: number; offset: number; hasMore: boolean }
    }
}

const API_BASE = env.EXTERNAL_API_BASE_URL || 'https://rk.etl.uzun.kz/api/v1'

const STOP_WORDS = new Set(['врач', 'доктор', 'doctor', 'дәрігер', 'dr', 'doktor'])

function levenshteinDistance(a: string, b: string): number {
    const alen = a.length
    const blen = b.length
    if (alen === 0) return blen
    if (blen === 0) return alen

    if (alen > blen) return levenshteinDistance(b, a)

    let prev = new Uint8Array(alen + 1)
    let curr = new Uint8Array(alen + 1)

    for (let i = 0; i <= alen; i++) prev[i] = i

    for (let j = 1; j <= blen; j++) {
        curr[0] = j
        for (let i = 1; i <= alen; i++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + cost)
        }
        ;[prev, curr] = [curr, prev]
    }

    return prev[alen]
}

function fuzzyMatch(word: string, target: string): boolean {
    if (target.length === 0) return false
    const threshold = word.length >= 5 ? 2 : 1
    return levenshteinDistance(word, target) <= threshold
}

function toLowerText(value: unknown): string {
    if (typeof value === 'string') return value.toLowerCase()
    if (value && typeof value === 'object') {
        const name = (value as { name?: unknown }).name
        if (typeof name === 'string') return name.toLowerCase()
    }
    return ''
}

function toLowerTextShort(value: unknown): string {
    if (typeof value === 'string') return value.toLowerCase()
    if (value && typeof value === 'object') {
        const v = value as { name?: string; shortName?: string }
        const text = v.shortName ?? v.name
        if (typeof text === 'string') return text.toLowerCase()
    }
    return ''
}

function matchScore(doctor: MDoctor, queryWords: string[]): number {
    let score = 0
    const full = toLowerText(doctor.fullName)
    const query = queryWords.join(' ')

    if (full === query) score += 100
    else if (full.startsWith(query)) score += 50

    const firstName = toLowerText(doctor.firstName)
    const lastName = toLowerText(doctor.lastName)
    const middleName = toLowerText(doctor.middleName)
    const position = toLowerText(doctor.position)
    const positionShort = toLowerTextShort(doctor.position)
    const deptName = toLowerText(doctor.department?.name)
    const branchName = toLowerText(doctor.department?.branch?.name)

    for (const word of queryWords) {
        const w = word.toLowerCase()
        let exactHit = false

        if (full.includes(w)) {
            score += 10
            exactHit = true
        }
        if (firstName.includes(w)) {
            score += 5
            exactHit = true
        }
        if (lastName.includes(w)) {
            score += 5
            exactHit = true
        }
        if (middleName.includes(w)) {
            score += 5
            exactHit = true
        }
        if (position.includes(w) || positionShort.includes(w)) {
            score += 15
            exactHit = true
        }
        if (deptName.includes(w)) {
            score += 10
            exactHit = true
        }
        if (branchName.includes(w)) {
            score += 5
            exactHit = true
        }

        if (!exactHit) {
            if (fuzzyMatch(w, full)) score += 5
            else if (fuzzyMatch(w, position) || fuzzyMatch(w, positionShort)) score += 8
            else if (fuzzyMatch(w, deptName)) score += 5
            else if (fuzzyMatch(w, branchName)) score += 3
        }
    }

    return score
}

async function fetchAllDoctors(): Promise<MDoctor[]> {
    const allDoctors: MDoctor[] = []
    let offset = 0
    const limit = 50
    let hasMore = true

    while (hasMore) {
        const res = await fetch(`${API_BASE}/doctors?limit=${limit}&offset=${offset}`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(10000)
        })

        if (!res.ok) {
            log.error({ module: 'tools', status: res.status }, 'doctor search API error')
            return allDoctors
        }

        const body = (await res.json()) as DoctorsResponse
        if (!body.success || !body.data?.doctors) return allDoctors

        allDoctors.push(...body.data.doctors)
        hasMore = body.data.pagination?.hasMore ?? false
        offset += limit
    }

    return allDoctors
}

// branchRef1cId — ID филиала в 1С. Фильтруем СТРОГО по этому ID, а не по названию
// филиала: внешний API возвращает department.branch.name на латинице ("IRM Clinic
// Almaty"), а наш справочник филиалов (src/constants/branches.ts) — на кириллице
// ("IRM Алматы"). Сравнение по названию никогда не совпадёт между собой, поэтому
// единственный надёжный ключ — ref1cId, который идентичен в обеих системах.
export async function findDoctors(query: string, limit = 5, branchRef1cId?: string): Promise<MDoctor[]> {
    const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 0 && !STOP_WORDS.has(w))

    if (words.length === 0) return []

    try {
        const allDoctors = await fetchAllDoctors()

        const filteredDoctors = branchRef1cId ? allDoctors.filter((d) => d.department?.branch?.ref1cId === branchRef1cId) : allDoctors

        const scored = filteredDoctors
            .map((d) => ({ doctor: d, score: matchScore(d, words) }))
            .filter((d) => d.score > 0)
            .sort((a, b) => b.score - a.score)

        log.info(
            {
                module: 'tools',
                query,
                branchFilter: branchRef1cId,
                matches: scored.length,
                total: allDoctors.length
            },
            'doctor search'
        )

        return scored.slice(0, limit).map((d) => d.doctor)
    } catch (err) {
        log.error({ module: 'tools', error: String(err) }, 'doctor search failed')
        return []
    }
}

export async function findDoctor(query: string): Promise<MDoctor | null> {
    const doctors = await findDoctors(query, 1)
    return doctors[0] ?? null
}
