import { desc, eq, sql } from 'drizzle-orm'

import { env } from '../../config/constants'
import { db } from '../../db/client'
import { conversations, messages } from '../../db/schema'
import { chat } from '../llm/openrouter'
import { SYSTEM_PROMPT_SUMMARY } from './prompts'

const BOT_ID = env.INSTAGRAM_BUSINESS_ID
const MAX_HISTORY = 6
const SUMMARY_THRESHOLD = 6

function role(fromId: string): string {
    return fromId === BOT_ID ? 'assistant' : 'user'
}

export interface FormattedContext {
    history: string
    messageCount: number
    needsSummary: boolean
    metadata: Record<string, unknown> | null
}

export type PendingInfo = {
    type: 'prices'
    query: string
    missing: Array<'branch' | 'citizenship'>
}

export async function getConversationContext(conversationId: bigint): Promise<FormattedContext> {
    const conv = await db
        .select({
            summary: conversations.summary,
            messageCount: conversations.messageCount,
            metadata: conversations.metadata
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .then((rows) => rows[0])

    const messageCount = conv?.messageCount ?? 0

    const recentMessages = await db
        .select({ fromId: messages.fromId, text: messages.text })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(MAX_HISTORY)

    const orderedMessages = [...recentMessages].reverse()
    const historyLines = orderedMessages.map((m) => `${role(m.fromId)}: ${m.text}`)

    const needsSummary = messageCount > SUMMARY_THRESHOLD && conv?.summary

    let result = ''
    if (needsSummary && conv?.summary) {
        result += `[Краткое содержание предыдущего диалога: ${conv.summary}]\n\n`
    }

    result += historyLines.join('\n')

    return {
        history: result,
        messageCount,
        needsSummary: !!needsSummary,
        metadata: conv?.metadata ?? null
    }
}

export async function updateConversationSummary(conversationId: bigint): Promise<void> {
    const allMessages = await db
        .select({ fromId: messages.fromId, text: messages.text })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(20)

    const orderedMessages = [...allMessages].reverse()

    if (orderedMessages.length < SUMMARY_THRESHOLD) return

    const dialogue = orderedMessages.map((m) => `${role(m.fromId)}: ${m.text}`).join('\n')

    try {
        const summary = (
            await chat([
                {
                    role: 'system',
                    content: SYSTEM_PROMPT_SUMMARY
                },
                { role: 'user', content: dialogue }
            ])
        ).content

        await db
            .update(conversations)
            .set({ summary: summary || null })
            .where(eq(conversations.id, conversationId))
    } catch {
        // summary generation failed silently
    }
}

export async function incrementMessageCount(conversationId: bigint): Promise<void> {
    await db
        .update(conversations)
        .set({
            messageCount: sql`${conversations.messageCount} + 1`,
            updatedAt: new Date()
        })
        .where(eq(conversations.id, conversationId))
}

function normalizeMetadata(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {}
    return { ...meta }
}

export function getPendingInfo(metadata: Record<string, unknown> | null | undefined): PendingInfo | null {
    if (!metadata || typeof metadata !== 'object') return null
    const candidate = (metadata as Record<string, unknown>).pendingInfo
    if (!candidate || typeof candidate !== 'object') return null

    const pending = candidate as Record<string, unknown>
    if (pending.type !== 'prices') return null
    if (typeof pending.query !== 'string' || !pending.query.trim()) return null
    if (!Array.isArray(pending.missing)) return null

    const missing = pending.missing
        .filter((item) => item === 'branch' || item === 'citizenship')
        .map((item) => item as 'branch' | 'citizenship')

    if (missing.length === 0) return null

    return {
        type: 'prices',
        query: pending.query,
        missing
    }
}

export async function setPendingInfo(
    conversationId: bigint,
    pending: PendingInfo | null,
    currentMetadata?: Record<string, unknown> | null
): Promise<void> {
    const metadata = normalizeMetadata(currentMetadata)
    if (pending) {
        metadata.pendingInfo = pending
    } else {
        delete metadata.pendingInfo
    }

    const nextMeta = Object.keys(metadata).length > 0 ? metadata : null

    await db
        .update(conversations)
        .set({ metadata: nextMeta, updatedAt: new Date() })
        .where(eq(conversations.id, conversationId))
}
