import { env } from '../../config/constants'
import {
    buildBranchClarificationPrompt,
    findBranchByNameOrCity,
    findBranchByRef1cId
} from '../../constants/branches'
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

interface BusySlot {
    dateStart: string
    dateEnd: string
}

interface ScheduleDay {
    date: string
    dayOfWeek: number
    isWorkDay: boolean
    workPeriods: WorkPeriod[]
    busySlots: BusySlot[]
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

// Полное название дня недели + число и месяц выводим ОДНОЙ строкой, вычисляя их
// из самой даты (day.date), а не из поля dayOfWeek API — так день недели и число
// физически не могут разойтись, и LLM не приходится самой сопоставлять сокращения
// (пн/вт/ср) с частичными датами (MM-DD), что было источником путаницы дат.
function formatDayLabel(dateStr: string): string {
    const d = new Date(`${dateStr}T00:00:00`)
    return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })
}

// Внешний API игнорирует параметры from/to и возвращает расписание за весь
// доступный диапазон (обычно месяц). Обрезаем до запрошенной недели, чтобы
// заголовок "на текущую неделю" соответствовал действительности и модель не
// путалась в одинаковых повторяющихся записях за разные недели.
function trimToWeek(schedule: ScheduleDay[], monday: Date, sunday: Date): ScheduleDay[] {
    const from = formatDate(monday)
    const to = formatDate(sunday)
    return schedule.filter((d) => d.date >= from && d.date <= to)
}

// Собираем количество занятых окон на каждый день из всех busySlots ответа API.
// busySlots в каждом дне API хранятся со смещением: обычно слоты дня X лежат
// в бакете с датой X-1 (UTC-конвенция). Мы собираем их все в плоский список
// и считаем количество уникальных dateStart на каждую дату (отсекая время).
function countBusySlotsByDate(schedule: ScheduleDay[]): Map<string, number> {
    const counts = new Map<string, number>()
    for (const day of schedule) {
        for (const slot of day.busySlots) {
            const date = slot.dateStart.slice(0, 10)
            counts.set(date, (counts.get(date) || 0) + 1)
        }
    }
    return counts
}

function formatScheduleDays(schedule: ScheduleDay[], busyCounts: Map<string, number>): string {
    const lines: string[] = []

    for (const day of schedule) {
        const label = formatDayLabel(day.date)

        if (!day.isWorkDay || day.workPeriods.length === 0) {
            lines.push(`${label} — выходной`)
            continue
        }

        const periods = day.workPeriods
            .filter((p) => p.timeType !== 'busy')
            .map((p) => `${p.startTime.slice(0, 5)}–${p.endTime.slice(0, 5)}`)

        if (periods.length === 0) {
            lines.push(`${label} — нет свободного времени`)
        } else {
            const busy = busyCounts.get(day.date)
            const busyNote =
                busy && busy > 0 ? ` (есть занятые окна — ${busy} шт., уточни у пациента точное время)` : ''
            lines.push(`${label}: ${periods.join(', ')}${busyNote}`)
        }
    }

    return lines.join('\n')
}

function formatSchedule(
    doctor: MDoctor,
    schedule: ScheduleDay[],
    branchName: string,
    monday: Date,
    sunday: Date
): string {
    const weekSchedule = trimToWeek(schedule, monday, sunday)
    const busyCounts = countBusySlotsByDate(schedule)
    const header = `Расписание врача ${doctor.fullName} на текущую неделю (${formatDate(monday)} – ${formatDate(sunday)}) в филиале ${branchName}:`
    const consultPrice = doctor.consultPrice
        ? `\n\nСтоимость консультации: ${Number(doctor.consultPrice).toLocaleString('ru-RU')} ₸`
        : ''
    return `${header}\n\n${formatScheduleDays(weekSchedule, busyCounts)}${consultPrice}`
}

function hasFreeSlots(schedule: ScheduleDay[], monday: Date, sunday: Date): boolean {
    return trimToWeek(schedule, monday, sunday).some(
        (day) => day.isWorkDay && day.workPeriods.some((p) => p.timeType !== 'busy')
    )
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
        const branchRef = String(args.branch_ref1c_id ?? '').trim()
        const branchNameInput = String(args.branch_name ?? '').trim()

        let resolvedBranchName = branchNameInput
        let resolvedBranchRef = branchRef

        if (!resolvedBranchRef && branchNameInput) {
            const branch = findBranchByNameOrCity(branchNameInput)
            if (branch) {
                resolvedBranchRef = branch.ref1cId
                resolvedBranchName = branch.name
            }
        }

        if (!resolvedBranchRef) {
            return {
                success: true,
                answer: buildBranchClarificationPrompt(branchNameInput),
                found: false
            }
        }

        // branch_ref1c_id мог прийти напрямую (без branch_name) — для отображения
        // пациенту находим человекочитаемое название филиала по ID.
        if (!resolvedBranchName) {
            resolvedBranchName = findBranchByRef1cId(resolvedBranchRef)?.name ?? resolvedBranchRef
        }

        const doctors = await findDoctors(query, 5, resolvedBranchRef)

        if (doctors.length === 0) {
            return {
                success: true,
                found: false,
                answer:
                    `К сожалению, я не нашла врача по Вашему запросу в филиале ${resolvedBranchName}. ` +
                    'Попробуйте уточнить фамилию, специальность или выбрать другой филиал.'
            }
        }

        const monday = getMondayOfCurrentWeek()
        const sunday = new Date(monday)
        sunday.setDate(sunday.getDate() + 6)

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

            if (hasFreeSlots(schedule, monday, sunday)) {
                let answer = formatSchedule(doctor, schedule, resolvedBranchName, monday, sunday)
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
