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
        branch: { name: string }
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

function toLowerText(value: unknown): string {
    if (typeof value === 'string') return value.toLowerCase()
    if (value && typeof value === 'object') {
        const name = (value as { name?: unknown }).name
        if (typeof name === 'string') return name.toLowerCase()
    }
    return ''
}

function matchScore(doctor: MDoctor, queryWords: string[]): number {
    let score = 0
    const full = toLowerText(doctor.fullName)
    const query = queryWords
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w !== 'врач')
        .join(' ')

    if (full === query) score += 100
    else if (full.startsWith(query)) score += 50

    for (const word of queryWords) {
        const w = word.toLowerCase()
        if (full.includes(w)) score += 10
        if (toLowerText(doctor.firstName).includes(w)) score += 5
        if (toLowerText(doctor.lastName).includes(w)) score += 5
        if (toLowerText(doctor.middleName).includes(w)) score += 5
        if (toLowerText(doctor.position).includes(w)) score += 15
        if (toLowerText(doctor.department?.name).includes(w)) score += 10
        if (toLowerText(doctor.department?.branch?.name).includes(w)) score += 5
    }

    return score
}

export async function findDoctor(query: string): Promise<MDoctor | null> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)

    try {
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
                return null
            }

            const body = (await res.json()) as DoctorsResponse
            if (!body.success || !body.data?.doctors) return null

            allDoctors.push(...body.data.doctors)
            hasMore = body.data.pagination?.hasMore ?? false
            offset += limit
        }

        const scored = allDoctors
            .map((d) => ({ doctor: d, score: matchScore(d, words) }))
            .filter((d) => d.score > 0)
            .sort((a, b) => b.score - a.score)

        log.info({ module: 'tools', query, matches: scored.length, total: allDoctors.length }, 'doctor search')

        return scored.length > 0 ? scored[0].doctor : null
    } catch (err) {
        log.error({ module: 'tools', error: String(err) }, 'doctor search failed')
        return null
    }
}
