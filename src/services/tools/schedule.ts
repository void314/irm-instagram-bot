import { env } from '../../config/constants'
import { log } from '../logger'
import { type MDoctor, findDoctors } from './doctor-search'
import type { Tool, ToolResult } from './types'

const API_BASE = env.EXTERNAL_API_BASE_URL || 'https://rk.etl.uzun.kz/api/v1'

interface WorkPeriod {
    startTime: string
    endTime: string
    timeType: string
    cabinetRef1cId: string | null
    branchRef1cId: string
}

interface ScheduleDay {
    date: string
    dayOfWeek: number
    isWorkDay: boolean
    workPeriods: WorkPeriod[]
    busySlots: unknown[]
}

interface ScheduleResponse {
    success: boolean
    data: {
        doctor: { fullName: string }
        dateRange: { from: string; to: string }
        summary: { workDays: number; totalWorkHours: number }
        schedule: ScheduleDay[]
    }
}

function getMondayOfCurrentWeek(): Date {
    const now = new Date()
    const day = now.getDay()
    const diff = now.getDate() - day + (day === 0 ? -6 : 1)
    const monday = new Date(now)
    monday.setDate(diff)
    monday.setHours(0, 0, 0, 0)
    return monday
}

function formatDate(d: Date): string {
    return d.toISOString().slice(0, 10)
}

const DAY_NAMES_SHORT: Record<number, string> = {
    1: 'пн',
    2: 'вт',
    3: 'ср',
    4: 'чт',
    5: 'пт',
    6: 'сб',
    0: 'вс'
}

function formatScheduleDays(schedule: ScheduleDay[]): string {
    const lines: string[] = []

    for (const day of schedule) {
        const dayName = DAY_NAMES_SHORT[day.dayOfWeek] || ''
        const dateStr = day.date.slice(5)

        if (!day.isWorkDay || day.workPeriods.length === 0) {
            lines.push(`${dayName} ${dateStr} — выходной`)
            continue
        }

        const periods = day.workPeriods
            .filter((p) => p.timeType !== 'busy')
            .map((p) => `${p.startTime.slice(0, 5)}–${p.endTime.slice(0, 5)}`)

        if (periods.length === 0) {
            lines.push(`${dayName} ${dateStr} — нет свободного времени`)
        } else {
            lines.push(`${dayName} ${dateStr}: ${periods.join(', ')}`)
        }
    }

    return lines.join('\n')
}

function formatSchedule(doctor: MDoctor, schedule: ScheduleDay[]): string {
    const header = `Расписание врача ${doctor.fullName} на текущую неделю:`
    const consultPrice = doctor.consultPrice
        ? `\n\nСтоимость консультации: ${Number(doctor.consultPrice).toLocaleString('ru-RU')} ₸`
        : ''
    return `${header}\n\n${formatScheduleDays(schedule)}${consultPrice}`
}

function hasFreeSlots(schedule: ScheduleDay[]): boolean {
    return schedule.some((day) => day.isWorkDay && day.workPeriods.some((p) => p.timeType !== 'busy'))
}

async function fetchScheduleRaw(doctor: MDoctor): Promise<ScheduleDay[] | null> {
    const monday = getMondayOfCurrentWeek()
    const sunday = new Date(monday)
    sunday.setDate(sunday.getDate() + 6)

    try {
        const url = `${API_BASE}/doctors/${doctor.id}/schedule?from=${formatDate(monday)}&to=${formatDate(sunday)}`
        const res = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(10000)
        })

        if (!res.ok) {
            log.error({ module: 'tools', status: res.status, doctorId: doctor.id }, 'schedule API error')
            return null
        }

        const body = (await res.json()) as ScheduleResponse
        if (!body.success || !body.data) return null

        return body.data.schedule || []
    } catch (err) {
        log.error({ module: 'tools', error: String(err) }, 'schedule fetch failed')
        return null
    }
}

export const scheduleTool: Tool = {
    name: 'schedule',

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const query = String(args.doctor_name ?? args.query ?? '').trim()

        const doctors = await findDoctors(query, 5)

        if (doctors.length === 0) {
            return {
                success: true,
                found: false,
                answer:
                    'К сожалению, я не нашла врача по Вашему запросу. ' +
                    'Попробуйте уточнить фамилию или специальность врача.'
            }
        }

        const skipNotes: string[] = []

        for (const doctor of doctors) {
            if (!doctor.isCalendarActive) {
                skipNotes.push(`Врач ${doctor.fullName} временно не ведёт приём.`)
                continue
            }

            const schedule = await fetchScheduleRaw(doctor)
            if (schedule === null) {
                skipNotes.push(`У врача ${doctor.fullName} не удалось загрузить расписание.`)
                continue
            }

            if (hasFreeSlots(schedule)) {
                let answer = formatSchedule(doctor, schedule)
                if (skipNotes.length > 0) {
                    const notes = skipNotes.join('\n')
                    answer = `${notes}\n\nНо ${doctor.firstName || doctor.fullName} может принять:\n\n${answer}`
                }
                return { success: true, found: true, answer }
            }

            skipNotes.push(`У врача ${doctor.fullName} на этой неделе нет свободного времени.`)
        }

        if (skipNotes.length === 1) {
            const note = skipNotes[0]
            if (note.includes('не ведёт приём')) {
                return {
                    success: true,
                    found: false,
                    answer: `${note} Пожалуйста, выберите другого специалиста.`
                }
            }
            return {
                success: true,
                found: false,
                answer: `${note} Попробуйте обратиться позже или запишитесь через кол-центр.`
            }
        }

        return {
            success: true,
            found: false,
            answer:
                'К сожалению, у всех найденных врачей нет свободного времени на этой неделе:\n' +
                skipNotes.join('\n')
        }
    }
}
