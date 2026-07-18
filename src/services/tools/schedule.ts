import { env } from '../../config/constants'
import { log } from '../logger'
import { type MDoctor, findDoctor } from './doctor-search'
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

function formatSchedule(doctor: MDoctor, schedule: ScheduleDay[]): string {
    const lines: string[] = [`Расписание врача ${doctor.fullName} на текущую неделю:`, '']

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

export const scheduleTool: Tool = {
    name: 'schedule',

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const query = String(args.doctor_name ?? args.query ?? '').trim()
        const doctor = await findDoctor(query)

        if (!doctor) {
            return {
                success: true,
                answer:
                    'К сожалению, я не нашла врача по Вашему запросу. ' +
                    'Попробуйте уточнить фамилию или специальность врача.'
            }
        }

        if (!doctor.isCalendarActive) {
            return {
                success: true,
                answer:
                    `Врач ${doctor.fullName} временно не ведёт приём. ` +
                    'Пожалуйста, выберите другого специалиста.'
            }
        }

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
                return {
                    success: true,
                    answer: 'Не удалось получить расписание. Попробуйте позже или запишитесь через кол-центр.'
                }
            }

            const body = (await res.json()) as ScheduleResponse
            if (!body.success || !body.data) {
                return {
                    success: true,
                    answer: 'Не удалось загрузить расписание. Попробуйте позже.'
                }
            }

            const schedule = body.data.schedule || []
            const formatted = formatSchedule(doctor, schedule)
            const consultPrice = doctor.consultPrice
                ? `\n\nСтоимость консультации: ${Number(doctor.consultPrice).toLocaleString('ru-RU')} ₸`
                : ''

            return {
                success: true,
                answer: `${formatted}${consultPrice}`
            }
        } catch (err) {
            log.error({ module: 'tools', error: String(err) }, 'schedule fetch failed')
            return {
                success: true,
                answer: 'Не удалось загрузить расписание. Попробуйте позже.'
            }
        }
    }
}
