import { env } from '../../config/constants'
import { getBranchesList } from '../../constants/branches'
import { type ChatMessage, chat } from '../../services/llm/openrouter'
import { log } from '../../services/logger'
import { updateConversationMetadata } from '../../services/rag/context'
import { type PatientInfo, updatePatient } from '../../services/rag/patient'
import { executeTool } from '../../services/tools'
import type { AgentResult } from '../types'

type PendingToolClarification = 'branch' | 'citizenship'

// Эти функции возвращают НЕ готовый текст вопроса пользователю, а терсе data-заметку
// для главного агента (оркестратора). Сам вопрос формулирует оркестратор — он видит
// историю диалога и не будет повторно спрашивать/перечислять то, что уже говорил.
function buildBranchDataNote(): string {
    return `ТРЕБУЕТСЯ уточнение у пользователя: филиал клиники не указан. Доступные филиалы:\n${getBranchesList()}`
}

function buildCitizenshipDataNote(): string {
    return 'ТРЕБУЕТСЯ уточнение у пользователя: гражданство не указано (гражданин РК или иностранный гражданин) — стоимость услуг отличается.'
}

const CITIZENSHIP_EXTRACTION_PROMPT = `Ты — классификатор гражданства.
Проанализируй ответ пользователя и определи его гражданство.

Правила:
- Если пользователь явно указал, что он гражданин РК, Казахстана, или Резидент — верни "kz"
- Если пользователь явно указал, что он иностранец, нерезидент, гражданин другой страны — верни "foreign"
- Если пользователь не ответил на вопрос о гражданстве, или ответ неясен — верни "unknown"

Ответь строго в формате JSON: {"citizenship": "kz" | "foreign" | "unknown"}`

function extractJsonObject(raw: string): string {
    const trimmed = raw.trim()
    if (!trimmed) return ''

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (fenced) return fenced[1].trim()

    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return trimmed.slice(firstBrace, lastBrace + 1)
    }

    return trimmed
}

async function extractCitizenshipFromQuery(query: string): Promise<'kz' | 'foreign' | null> {
    let answer: { content: string }

    try {
        answer = await chat(
            [
                { role: 'system', content: CITIZENSHIP_EXTRACTION_PROMPT },
                { role: 'user', content: query }
            ],
            {
                model: env.TOOL_MODEL,
                temperature: 0,
                maxTokens: 50,
                responseFormat: { type: 'json_object' }
            }
        )
    } catch {
        try {
            answer = await chat(
                [
                    { role: 'system', content: CITIZENSHIP_EXTRACTION_PROMPT },
                    { role: 'user', content: query }
                ],
                { model: env.TOOL_MODEL, temperature: 0, maxTokens: 50 }
            )
        } catch (e) {
            log.warn({ module: 'agent:tool', error: String(e) }, 'Citizenship extraction failed')
            return null
        }
    }

    if (!answer.content || !answer.content.trim()) return null

    try {
        const jsonStr = extractJsonObject(answer.content)
        if (!jsonStr) return null

        const parsed = JSON.parse(jsonStr) as Record<string, unknown>
        const citizenship = parsed.citizenship

        if (citizenship === 'kz' || citizenship === 'foreign') {
            log.info({ module: 'agent:tool', citizenship, source: 'llm_extraction' }, 'Citizenship extracted from user response')
            return citizenship as 'kz' | 'foreign'
        }

        return null
    } catch (e) {
        log.warn({ module: 'agent:tool', error: String(e) }, 'Citizenship extraction failed')
        return null
    }
}

async function updatePendingToolClarifications(conversationId: bigint, pending: PendingToolClarification[]): Promise<void> {
    if (conversationId <= 0) return
    await updateConversationMetadata(conversationId, { pendingToolClarifications: pending })
}

export async function handlePriceIntent(
    query: string,
    patient: PatientInfo | null,
    senderId: string,
    conversationId: bigint,
    lang: 'ru' | 'kk' | 'en' = 'ru',
    history?: ChatMessage[]
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
        await updatePendingToolClarifications(conversationId, missing)

        const notes: string[] = []
        if (missing.includes('branch')) notes.push(buildBranchDataNote())
        if (missing.includes('citizenship')) notes.push(buildCitizenshipDataNote())

        return {
            content: notes.join('\n\n'),
            confidence: 'low',
            gaps: [],
            updatedPatient: updatedPatient as unknown as Record<string, unknown> | undefined
        }
    }

    if (updatedPatient?.preferredBranchRef1cId) toolArgs.branch_ref1c_id = updatedPatient.preferredBranchRef1cId
    if (updatedPatient?.preferredBranch) toolArgs.branch_name = updatedPatient.preferredBranch
    if (effectiveCitizenship) toolArgs.citizenship = effectiveCitizenship

    try {
        const result = await executeTool('get_prices', toolArgs, updatedPatient)
        await updatePendingToolClarifications(conversationId, [])
        log.info({ module: 'agent:tool', hasPatient: !!updatedPatient }, 'Price intent: tool direct')

        if (result.found) {
            return {
                content: result.answer,
                confidence: 'high',
                gaps: [],
                updatedPatient: updatedPatient as unknown as Record<string, unknown> | undefined
            }
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
            updatedPatient: updatedPatient as unknown as Record<string, unknown> | undefined
        }
    } catch (err) {
        await updatePendingToolClarifications(conversationId, [])
        log.error({ module: 'agent:tool', error: String(err) }, 'Price intent tool error')
        let answer = ''
        switch (lang) {
            case 'kk':
                answer = 'Бағаларды алу мүмкін болмады. Қайтадан байқап көріңіз.'
                break
            case 'en':
                answer = 'Could not retrieve prices. Please try again.'
                break
            default:
                answer = 'Не удалось получить цены. Попробуйте ещё раз.'
                break
        }

        return {
            content: answer,
            confidence: 'low',
            gaps: [],
            updatedPatient: updatedPatient as unknown as Record<string, unknown> | undefined
        }
    }
}
