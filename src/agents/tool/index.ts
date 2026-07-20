import { getBranchesList } from '../../constants/branches'
import { chat } from '../../services/llm/openrouter'
import { log } from '../../services/logger'
import { type PatientInfo, updatePatient } from '../../services/rag/patient'
import { executeTool } from '../../services/tools'
import type { AgentResult } from '../types'

function buildBranchQuestion(lang: 'ru' | 'kk' | 'en'): string {
    if (lang === 'kk') return `Клиника филиалын нақтылаңызшы.\nҚолжетімді филиалдар:\n${getBranchesList()}`
    if (lang === 'en') return `Please specify the clinic branch.\nAvailable branches:\n${getBranchesList()}`
    return `Пожалуйста, уточните филиал клиники.\nДоступные филиалы:\n${getBranchesList()}`
}

function buildCitizenshipQuestion(lang: 'ru' | 'kk' | 'en'): string {
    if (lang === 'kk')
        return 'Азаматтығыңызды көрсетуіңізді сұраймыз (ҚР азаматы немесе шетел азаматы) — қызметтердің құны өзгешеленеді.'
    if (lang === 'en')
        return 'Please tell us your citizenship (Resident of Kazakhstan or Foreign citizen) — the cost of services varies.'
    return 'Подскажите, пожалуйста, Ваше гражданство (гражданин РК или иностранный гражданин) — стоимость услуг отличается.'
}

const CITIZENSHIP_EXTRACTION_PROMPT = `Ты — классификатор гражданства.
Проанализируй ответ пользователя и определи его гражданство.

Правила:
- Если пользователь явно указал, что он гражданин РК, Казахстана, или Резидент — верни "kz"
- Если пользователь явно указал, что он иностранец, нерезидент, гражданин другой страны — верни "foreign"
- Если пользователь не ответил на вопрос о гражданстве, или ответ неясен — верни "unknown"

Ответь строго в формате JSON: {"citizenship": "kz" | "foreign" | "unknown"}`

async function extractCitizenshipFromQuery(query: string): Promise<'kz' | 'foreign' | null> {
    try {
        const result = await chat(
            [
                { role: 'system', content: CITIZENSHIP_EXTRACTION_PROMPT },
                { role: 'user', content: query }
            ],
            {
                model: 'openai/gpt-4o-mini',
                temperature: 0,
                max_tokens: 30,
                response_format: { type: 'json_object' }
            }
        )

        const parsed = JSON.parse(result.content)
        const citizenship = parsed.citizenship

        if (citizenship === 'kz' || citizenship === 'foreign') {
            log.info(
                { module: 'agent:tool', citizenship, source: 'llm_extraction' },
                'Citizenship extracted from user response'
            )
            return citizenship
        }

        return null
    } catch (e) {
        log.warn({ module: 'agent:tool', error: String(e) }, 'Citizenship extraction failed')
        return null
    }
}

export async function handlePriceIntent(
    query: string,
    patient: PatientInfo | null,
    senderId: string,
    conversationId: bigint,
    lang: 'ru' | 'kk' | 'en' = 'ru',
    history?: string
): Promise<AgentResult> {
    const toolArgs: Record<string, unknown> = { query, lang }
    let updatedPatient = patient

    // Try to extract citizenship from user response if missing
    let effectiveCitizenship = updatedPatient?.citizenship
    if (!effectiveCitizenship) {
        const extractedCitizenship = await extractCitizenshipFromQuery(query)
        if (extractedCitizenship) {
            await updatePatient(senderId, { citizenship: extractedCitizenship })
            effectiveCitizenship = extractedCitizenship
            updatedPatient = {
                ...(updatedPatient ?? {
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
                }),
                citizenship: extractedCitizenship
            }
        }
    }

    const missing: Array<'branch' | 'citizenship'> = []
    if (!updatedPatient?.preferredBranchRef1cId) missing.push('branch')
    if (!effectiveCitizenship) missing.push('citizenship')

    if (missing.length > 0) {
        const baseAnswer = missing.includes('branch') ? buildBranchQuestion(lang) : buildCitizenshipQuestion(lang)
        return { content: baseAnswer, confidence: 'low', gaps: [], updatedPatient }
    }

    if (updatedPatient?.preferredBranchRef1cId) toolArgs.branch_ref1c_id = updatedPatient.preferredBranchRef1cId
    if (updatedPatient?.preferredBranch) toolArgs.branch_name = updatedPatient.preferredBranch
    if (effectiveCitizenship) toolArgs.citizenship = effectiveCitizenship

    try {
        const result = await executeTool('get_prices', toolArgs, updatedPatient)
        log.info({ module: 'agent:tool', hasPatient: !!updatedPatient }, 'Price intent: tool direct')

        if (result.found) {
            return { content: result.answer, confidence: 'high', gaps: [], updatedPatient }
        }

        return {
            content: result.answer,
            confidence: 'low',
            gaps: [
                {
                    type: 'service_composition',
                    description: 'Прямая цена не найдена. Нужно узнать состав услуги через базу знаний.',
                    priority: 'critical'
                }
            ],
            updatedPatient
        }
    } catch (err) {
        log.error({ module: 'agent:tool', error: String(err) }, 'Price intent tool error')
        const answer =
            lang === 'kk'
                ? 'Бағаларды алу мүмкін болмады. Қайтадан байқап көріңіз.'
                : lang === 'en'
                  ? 'Could not retrieve prices. Please try again.'
                  : 'Не удалось получить цены. Попробуйте ещё раз.'

        return { content: answer, confidence: 'low', gaps: [], updatedPatient }
    }
}
