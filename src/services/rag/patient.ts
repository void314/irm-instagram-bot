import { eq } from 'drizzle-orm'

import { findBranchByNameOrCity } from '../../constants/branches'
import { db } from '../../db/client'
import { patients } from '../../db/schema'
import { chat } from '../llm/openrouter'
import { log } from '../logger'

const FACEBOOK_GRAPH_API = 'https://graph.facebook.com'

export interface PatientInfo {
    senderId: string
    name: string | null
    instagramName: string | null
    instagramUsername: string | null
    instagramProfilePic: string | null
    citizenship: string | null
    phone: string | null
    preferredLang: string | null
    preferredBranch: string | null
    preferredBranchRef1cId: string | null
    hasBookedConsultation: boolean
    nameSource: string | null
    nameChangeOffered: boolean
    bookingNudgeOffered: boolean
}

export async function getPatient(senderId: string): Promise<PatientInfo | null> {
    const row = await db
        .select()
        .from(patients)
        .where(eq(patients.senderId, senderId))
        .then((rows) => rows[0])

    if (!row) return null

    return {
        senderId: row.senderId,
        name: row.name,
        instagramName: row.instagramName,
        instagramUsername: row.instagramUsername,
        instagramProfilePic: row.instagramProfilePic,
        citizenship: row.citizenship,
        phone: row.phone,
        preferredLang: row.preferredLang,
        preferredBranch: row.preferredBranch,
        preferredBranchRef1cId: row.preferredBranchRef1cId,
        hasBookedConsultation: row.hasBookedConsultation,
        nameSource: row.nameSource,
        nameChangeOffered: row.nameChangeOffered,
        bookingNudgeOffered: row.bookingNudgeOffered
    }
}

export async function ensurePatient(senderId: string): Promise<PatientInfo> {
    const existing = await getPatient(senderId)
    if (existing) return existing

    await db.insert(patients).values({ senderId }).execute()
    log.info({ module: 'patient', senderId }, 'patient record created')

    return {
        senderId,
        name: null,
        instagramName: null,
        instagramUsername: null,
        instagramProfilePic: null,
        citizenship: null,
        phone: null,
        preferredLang: null,
        preferredBranch: null,
        preferredBranchRef1cId: null,
        hasBookedConsultation: false,
        nameSource: null,
        nameChangeOffered: false,
        bookingNudgeOffered: false
    }
}

export async function updatePatient(
    senderId: string,
    data: Partial<Omit<PatientInfo, 'senderId'>>
): Promise<void> {
    const fields = Object.keys(data).filter((k) => data[k as keyof typeof data] !== undefined)
    if (fields.length > 0) {
        log.info(
            {
                module: 'patient',
                senderId,
                fields,
                values: fields.map((k) => `${k}=${JSON.stringify(data[k as keyof typeof data])}`)
            },
            'patient: saving fields'
        )
    }
    await db
        .update(patients)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(patients.senderId, senderId))
        .execute()
}

export async function fetchInstagramUserInfo(
    senderId: string,
    pageAccessToken: string
): Promise<{ name: string; username: string } | null> {
    try {
        const url = `${FACEBOOK_GRAPH_API}/v25.0/${senderId}?fields=name,username&access_token=${pageAccessToken}`
        const res = await fetch(url)
        if (!res.ok) {
            log.warn(
                { module: 'patient', senderId, status: res.status, statusText: res.statusText },
                'instagram user info fetch failed'
            )
            return null
        }

        const data = (await res.json()) as { name?: string; username?: string }
        if (!data.name && !data.username) {
            log.warn(
                { module: 'patient', senderId, response: JSON.stringify(data) },
                'instagram user info: empty response'
            )
            return null
        }

        log.info(
            { module: 'patient', senderId, name: data.name, username: data.username },
            'instagram user info fetched'
        )
        return { name: data.name || '', username: data.username || '' }
    } catch (err) {
        log.warn({ module: 'patient', senderId, error: String(err) }, 'instagram user info fetch error')
        return null
    }
}

const EXTRACTION_PROMPT = [
    'Извлеки информацию о пациенте из диалога ниже.',
    'Верни ТОЛЬКО JSON без пояснений, строго в формате:',
    '{',
    '  "name": string | null,',
    '  "citizenship": "kz" | "foreign" | null,',
    '  "phone": string | null,',
    '  "preferredBranch": string | null,',
    '  "hasBookedConsultation": boolean,',
    '  "nameChangeOffered": boolean',
    '}',
    '',
    'Правила:',
    '- name: имя, которое назвал пользователь (не instagram_name)',
    '- citizenship: "kz" если гражданин РК/Казахстана, "foreign" если иностранец',
    '- phone: номер телефона, если пользователь его оставил',
    '- preferredBranch: название филиала, который выбрал пользователь',
    '- hasBookedConsultation: true если записался на приём',
    '- nameChangeOffered: true если ты уже предлагала сменить имя (nickname → реальное)',
    '',
    'Если информации нет — возвращай null для поля.'
].join('\n')

function extractJsonObject(raw: string): string {
    const trimmed = raw.trim()
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (fenced) return fenced[1].trim()
    return trimmed
}

export async function extractPatientInfoFromDialogue(
    dialogue: string,
    currentPatient: PatientInfo
): Promise<Partial<Omit<PatientInfo, 'senderId'>>> {
    let rawContent = ''
    try {
        const answer = await chat(
            [
                { role: 'system', content: EXTRACTION_PROMPT },
                { role: 'user', content: dialogue }
            ],
            { model: 'openai/gpt-4o-mini', response_format: { type: 'json_object' } }
        )

        rawContent = answer.content
        const extracted = JSON.parse(extractJsonObject(rawContent)) as Partial<Omit<PatientInfo, 'senderId'>>
        const merged: Partial<Omit<PatientInfo, 'senderId'>> = {}

        for (const key of ['name', 'citizenship', 'phone', 'preferredBranch'] as const) {
            if (extracted[key] !== null && extracted[key] !== undefined) {
                merged[key] = extracted[key]
            }
        }

        // Если модель извлекла имя из диалога — это подтверждённое имя от пользователя,
        // а не инстаграм-никнейм, поэтому фиксируем источник.
        if (merged.name) {
            merged.nameSource = 'user'
        }

        if (merged.preferredBranch) {
            const branch = findBranchByNameOrCity(String(merged.preferredBranch))
            if (branch) {
                merged.preferredBranch = branch.name
                merged.preferredBranchRef1cId = branch.ref1cId
            }
        }

        if (typeof extracted.hasBookedConsultation === 'boolean') {
            merged.hasBookedConsultation = extracted.hasBookedConsultation
        }

        if (typeof extracted.nameChangeOffered === 'boolean' && extracted.nameChangeOffered) {
            merged.nameChangeOffered = true
        }

        const filledKeys = Object.keys(merged).filter(
            (k) => merged[k as keyof typeof merged] !== undefined && merged[k as keyof typeof merged] !== null
        )
        if (filledKeys.length > 0) {
            log.info(
                {
                    module: 'patient',
                    senderId: currentPatient.senderId,
                    extracted: filledKeys,
                    values: filledKeys.map((k) => `${k}=${JSON.stringify(merged[k as keyof typeof merged])}`)
                },
                'patient: extracted from dialogue'
            )
        }

        return merged
    } catch (err) {
        log.error(
            {
                module: 'patient',
                senderId: currentPatient.senderId,
                error: String(err),
                rawContent: rawContent.slice(0, 500)
            },
            'patient info extraction failed'
        )
        return {}
    }
}

export function formatPatientContext(patient: PatientInfo | null): string {
    if (!patient) return ''

    const parts: string[] = ['[Информация о пациенте:']

    if (patient.name) parts.push(`Имя: ${patient.name}`)
    if (patient.instagramName && patient.nameSource === 'instagram') {
        parts.push(`Instagram: ${patient.instagramName}`)
    }
    if (patient.citizenship === 'kz') parts.push('Гражданство: РК')
    else if (patient.citizenship === 'foreign') parts.push('Гражданство: иностранный')
    if (patient.phone) parts.push(`Телефон: ${patient.phone}`)
    if (patient.preferredBranch) parts.push(`Филиал: ${patient.preferredBranch}`)
    if (patient.preferredBranchRef1cId) {
        parts.push(`ID филиала: ${patient.preferredBranchRef1cId}`)
    }
    if (patient.hasBookedConsultation) parts.push('Статус: записан(а) на приём')

    if (parts.length === 1) return ''

    parts[0] += ' '
    parts[parts.length - 1] += ']'
    return parts.join(', ')
}
