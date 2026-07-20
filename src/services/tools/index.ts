import type { ToolDefinition } from '../llm/openrouter'
import type { PatientInfo } from '../rag/patient'
import { TOOL_DEFINITIONS } from './definitions'
import { pricesTool } from './prices'
import { scheduleTool } from './schedule'
import type { ToolResult } from './types'

type ToolFn = (args: Record<string, unknown>, patient?: PatientInfo | null) => Promise<ToolResult>

// Модель не всегда добросовестно копирует уже известные данные пациента
// (филиал, гражданство) в аргументы вызова инструмента. Чтобы get_prices не
// спрашивал повторно то, что уже сохранено в карточке пациента, детерминированно
// подставляем известные значения, если модель их не передала.
function enrichPricesArgs(args: Record<string, unknown>, patient?: PatientInfo | null): Record<string, unknown> {
    if (!patient) return args

    const enriched = { ...args }

    if (!enriched.branch_ref1c_id && !enriched.branch_name && patient.preferredBranchRef1cId) {
        enriched.branch_ref1c_id = patient.preferredBranchRef1cId
    }

    if (!enriched.citizenship && patient.citizenship) {
        enriched.citizenship = patient.citizenship
    }

    return enriched
}

const toolMap: Record<string, ToolFn> = {
    get_prices: (args, patient) => pricesTool.execute(enrichPricesArgs(args, patient)),
    get_doctor_schedule: (args) => scheduleTool.execute(args)
}

export function getToolDefinitions(): ToolDefinition[] {
    return TOOL_DEFINITIONS
}

export async function executeTool(
    functionName: string,
    args: Record<string, unknown>,
    patient?: PatientInfo | null
): Promise<ToolResult> {
    const fn = toolMap[functionName]
    if (!fn) {
        throw new Error(`Unknown tool: ${functionName}`)
    }

    return await fn(args, patient)
}
