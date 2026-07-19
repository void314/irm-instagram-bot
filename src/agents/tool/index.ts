import { findBranchByNameOrCity, getBranchesList } from '../../constants/branches'
import { log } from '../../services/logger'
import { type PendingInfo, setPendingInfo } from '../../services/rag/context'
import { type PatientInfo, updatePatient } from '../../services/rag/patient'
import { executeTool } from '../../services/tools'

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

export async function handlePriceIntent(
    query: string,
    patient: PatientInfo | null,
    senderId: string,
    conversationId: bigint,
    convoMetadata: Record<string, unknown> | null,
    lang: 'ru' | 'kk' | 'en' = 'ru'
): Promise<{ answer: string; missingInfo: boolean; updatedPatient: PatientInfo | null }> {
    const toolArgs: Record<string, unknown> = { query }
    const updatedPatient = patient

    const effectiveCitizenship = updatedPatient?.citizenship

    const missing: Array<'branch' | 'citizenship'> = []
    if (!updatedPatient?.preferredBranchRef1cId) missing.push('branch')
    if (!effectiveCitizenship) missing.push('citizenship')

    if (missing.length > 0) {
        await setPendingInfo(conversationId, { type: 'prices', query, missing }, convoMetadata)
        const baseAnswer = missing.includes('branch') ? buildBranchQuestion(lang) : buildCitizenshipQuestion(lang)
        return { answer: baseAnswer, missingInfo: true, updatedPatient }
    }

    if (updatedPatient?.preferredBranchRef1cId) toolArgs.branch_ref1c_id = updatedPatient.preferredBranchRef1cId
    if (updatedPatient?.preferredBranch) toolArgs.branch_name = updatedPatient.preferredBranch
    if (effectiveCitizenship) toolArgs.citizenship = effectiveCitizenship

    let answer = ''
    try {
        answer = await executeTool('get_prices', toolArgs, updatedPatient)
        log.info({ module: 'agent:tool', hasPatient: !!updatedPatient }, 'Price intent: tool direct')
    } catch (err) {
        log.error({ module: 'agent:tool', error: String(err) }, 'Price intent tool error')
        answer =
            lang === 'kk'
                ? 'Бағаларды алу мүмкін болмады. Қайтадан байқап көріңіз.'
                : lang === 'en'
                  ? 'Could not retrieve prices. Please try again.'
                  : 'Не удалось получить цены. Попробуйте ещё раз.'
    }

    return { answer, missingInfo: false, updatedPatient }
}

export function removeMissing(
    missing: Array<'branch' | 'citizenship'>,
    item: 'branch' | 'citizenship'
): Array<'branch' | 'citizenship'> {
    return missing.filter((value) => value !== item)
}
