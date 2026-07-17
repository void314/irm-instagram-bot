import { eq, desc, sql } from 'drizzle-orm'

import { db } from '../../db/client'
import { conversations, messages } from '../../db/schema'
import { chat } from '../llm/openrouter'
import { SYSTEM_PROMPT_SUMMARY } from './prompts'
import { env } from '../../config/constants'

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
}

export async function getConversationContext(conversationId: bigint): Promise<FormattedContext> {
    const conv = await db
        .select({ summary: conversations.summary, messageCount: conversations.messageCount })
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
        needsSummary: !!needsSummary
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

    const dialogue = orderedMessages
        .map((m) => `${role(m.fromId)}: ${m.text}`)
        .join('\n')

    try {
        const summary = await chat([
            {
                role: 'system',
                content: SYSTEM_PROMPT_SUMMARY
            },
            { role: 'user', content: dialogue }
        ])

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
