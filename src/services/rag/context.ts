import { asc, desc, eq, sql } from 'drizzle-orm'

import { env } from '../../config/constants'
import { db } from '../../db/client'
import { conversations, messages } from '../../db/schema'
import { type ChatMessage, chat } from '../llm/openrouter'
import { SYSTEM_PROMPT_SUMMARY } from './prompts'

const BOT_ID = env.INSTAGRAM_BUSINESS_ID
const MAX_HISTORY = 10
const SUMMARY_THRESHOLD = 8

function role(fromId: string): string {
    return fromId === BOT_ID ? 'assistant' : 'user'
}

export interface FormattedContext {
    history: ChatMessage[]
    messageCount: number
    needsSummary: boolean
    metadata: Record<string, unknown> | null
}

export async function getConversationContext(conversationId: bigint): Promise<FormattedContext> {
    const conv = await db
        .select({
            senderId: conversations.senderId,
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

    const history: ChatMessage[] = [...recentMessages]
        .map((m): ChatMessage => ({
            role: (m.fromId === conv.senderId ? 'user' : 'assistant') as 'user' | 'assistant',
            content: m.text || ''
        }))
        .slice(0, SUMMARY_THRESHOLD + 1)
        .reverse()

    // * Диалоговый контекст для LLM больше SUMMARY_THRESHOLD  сообщений
    const needsSummary = !!(messageCount > SUMMARY_THRESHOLD && conv?.summary)

    if (needsSummary && conv?.summary) {
        history.unshift({
            role: 'assistant' as const,
            content: `[Краткое содержание предыдущего диалога: ${conv.summary}]\n\n`
        })
    }

    return {
        history,
        messageCount,
        needsSummary: !!needsSummary,
        metadata: conv?.metadata ?? null
    }
}

export function getLastBotMessage(history: ChatMessage[]): string | null {
    if (!history || history.length === 0) return null
    const lines = history.find((m) => m.role === 'assistant')
    if (lines) return lines?.content || ''
    return null
}

export async function updateConversationMetadata(
    conversationId: bigint,
    updates: Record<string, unknown>,
    currentMetadata?: Record<string, unknown> | null
): Promise<void> {
    const meta = currentMetadata ? { ...currentMetadata } : {}
    Object.assign(meta, updates)

    await db.update(conversations).set({ metadata: meta, updatedAt: new Date() }).where(eq(conversations.id, conversationId))
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
