import Elysia, { status, t } from 'elysia'

import { count, desc, eq, like, sql } from 'drizzle-orm'

import { runPipeline } from '../../agents/orchestrator'
import { db } from '../../db/client'
import { conversations, messages, patients, services } from '../../db/schema'
import { findDoctor } from '../../services/tools/doctor-search'
import { pricesTool } from '../../services/tools/prices'
import { scheduleTool } from '../../services/tools/schedule'
import { feedbackController } from './feedback'
import { learningController } from './learning'

export const adminController = new Elysia({
    name: 'module.admin',
    prefix: '/admin',
    detail: { tags: ['Admin'] }
})
    .use(feedbackController)
    .use(learningController)

// ─── Conversations ────────────────────────────

adminController.get(
    '/conversations',
    async ({ query: { limit, offset } }) => {
        const rows = await db
            .select({
                id: conversations.id,
                senderId: conversations.senderId,
                businessId: conversations.businessId,
                messageCount: conversations.messageCount,
                hasSummary: sql<boolean>`${conversations.summary} IS NOT NULL`,
                createdAt: conversations.createdAt,
                updatedAt: conversations.updatedAt,
                lastMessage: sql<string | null>`
                    (SELECT m2.text FROM ${messages} m2
                     WHERE m2.conversation_id = ${conversations.id}
                     ORDER BY m2.created_at DESC LIMIT 1)
                `,
                lastMessageAt: sql<string | null>`
                    (SELECT m2.created_at::text FROM ${messages} m2
                     WHERE m2.conversation_id = ${conversations.id}
                     ORDER BY m2.created_at DESC LIMIT 1)
                `
            })
            .from(conversations)
            .orderBy(desc(conversations.updatedAt))
            .limit(limit ?? 50)
            .offset(offset ?? 0)

        const total = await db
            .select({ count: count() })
            .from(conversations)
            .then((r) => Number(r[0].count))

        return { conversations: rows, total }
    },
    {
        query: t.Object({
            limit: t.Optional(t.Numeric({ default: 50, maximum: 200 })),
            offset: t.Optional(t.Numeric({ default: 0 }))
        }),
        detail: {
            summary: 'List conversations',
            description: 'Returns conversations with last message preview'
        }
    }
)

adminController.get(
    '/conversations/:id',
    async ({ params: { id }, set }) => {
        const convId = BigInt(id)

        const conv = await db
            .select()
            .from(conversations)
            .where(eq(conversations.id, convId))
            .then((r) => r[0])

        if (!conv) {
            return status(404, { error: 'Conversation not found' })
        }

        const msgs = await db
            .select({
                id: messages.id,
                fromId: messages.fromId,
                text: messages.text,
                createdAt: messages.createdAt
            })
            .from(messages)
            .where(eq(messages.conversationId, convId))
            .orderBy(messages.createdAt)

        const patient = await db
            .select()
            .from(patients)
            .where(eq(patients.senderId, conv.senderId))
            .then((r) => r[0] ?? null)

        return {
            conversation: {
                id: conv.id.toString(),
                senderId: conv.senderId,
                businessId: conv.businessId,
                summary: conv.summary,
                messageCount: conv.messageCount,
                createdAt: conv.createdAt,
                updatedAt: conv.updatedAt
            },
            messages: msgs.map((m) => ({
                id: m.id.toString(),
                fromId: m.fromId,
                text: m.text,
                createdAt: m.createdAt
            })),
            patient: patient
                ? {
                      senderId: patient.senderId,
                      name: patient.name,
                      instagramName: patient.instagramName,
                      instagramUsername: patient.instagramUsername,
                      citizenship: patient.citizenship,
                      phone: patient.phone,
                      preferredBranch: patient.preferredBranch,
                      preferredBranchRef1cId: patient.preferredBranchRef1cId,
                      hasBookedConsultation: patient.hasBookedConsultation,
                      nameSource: patient.nameSource,
                      nameChangeOffered: patient.nameChangeOffered
                  }
                : null
        }
    },
    {
        params: t.Object({ id: t.String() }),
        detail: {
            summary: 'Get conversation details',
            description: 'Returns conversation with all messages and patient info'
        }
    }
)

// ─── Patients ─────────────────────────────────

adminController.get(
    '/patients',
    async ({ query: { limit, offset } }) => {
        const rows = await db
            .select({
                senderId: patients.senderId,
                name: patients.name,
                instagramName: patients.instagramName,
                instagramUsername: patients.instagramUsername,
                citizenship: patients.citizenship,
                phone: patients.phone,
                preferredBranch: patients.preferredBranch,
                preferredBranchRef1cId: patients.preferredBranchRef1cId,
                hasBookedConsultation: patients.hasBookedConsultation,
                nameSource: patients.nameSource,
                conversationCount: sql<number>`
                    (SELECT COUNT(*) FROM ${conversations}
                     WHERE sender_id = ${patients.senderId})
                `,
                updatedAt: patients.updatedAt
            })
            .from(patients)
            .orderBy(desc(patients.updatedAt))
            .limit(limit ?? 50)
            .offset(offset ?? 0)

        const total = await db
            .select({ count: count() })
            .from(patients)
            .then((r) => Number(r[0].count))

        return { patients: rows, total }
    },
    {
        query: t.Object({
            limit: t.Optional(t.Numeric({ default: 50, maximum: 200 })),
            offset: t.Optional(t.Numeric({ default: 0 }))
        }),
        detail: {
            summary: 'List patients',
            description: 'Returns patients with conversation count'
        }
    }
)

adminController.get(
    '/patients/:senderId',
    async ({ params: { senderId }, set }) => {
        const patient = await db
            .select()
            .from(patients)
            .where(eq(patients.senderId, senderId))
            .then((r) => r[0])

        if (!patient) {
            return status(404, { error: 'Patient not found' })
        }

        const convs = await db
            .select({
                id: conversations.id,
                messageCount: conversations.messageCount,
                createdAt: conversations.createdAt,
                updatedAt: conversations.updatedAt,
                lastMessage: sql<string | null>`
                    (SELECT m.text FROM ${messages} m
                     WHERE m.conversation_id = ${conversations.id}
                     ORDER BY m.created_at DESC LIMIT 1)
                `
            })
            .from(conversations)
            .where(eq(conversations.senderId, senderId))
            .orderBy(desc(conversations.updatedAt))

        return {
            patient: {
                senderId: patient.senderId,
                name: patient.name,
                instagramName: patient.instagramName,
                instagramUsername: patient.instagramUsername,
                citizenship: patient.citizenship,
                phone: patient.phone,
                preferredLang: patient.preferredLang,
                preferredBranch: patient.preferredBranch,
                preferredBranchRef1cId: patient.preferredBranchRef1cId,
                hasBookedConsultation: patient.hasBookedConsultation,
                nameSource: patient.nameSource,
                nameChangeOffered: patient.nameChangeOffered,
                createdAt: patient.createdAt,
                updatedAt: patient.updatedAt
            },
            conversations: convs.map((c) => ({
                id: c.id.toString(),
                messageCount: c.messageCount,
                lastMessage: c.lastMessage,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt
            }))
        }
    },
    {
        params: t.Object({ senderId: t.String() }),
        detail: {
            summary: 'Get patient details',
            description: 'Returns patient info with all their conversations'
        }
    }
)

// ─── Tools ────────────────────────────────────

adminController.post(
    '/tools/prices',
    async ({ body }) => {
        const result = await pricesTool.execute({
            query: body.query,
            branch_ref1c_id: body.branch_ref1c_id,
            branch_name: body.branch_name,
            citizenship: body.citizenship
        })
        return result
    },
    {
        body: t.Object({
            query: t.String(),
            branch_ref1c_id: t.Optional(t.String()),
            branch_name: t.Optional(t.String()),
            citizenship: t.Optional(t.Union([t.Literal('kz'), t.Literal('foreign')]))
        }),
        detail: {
            summary: 'Test prices tool',
            description: 'Manually execute price lookup tool and return results'
        }
    }
)

adminController.post(
    '/tools/schedule',
    async ({ body }) => {
        const result = await scheduleTool.execute({ doctor_name: body.query })
        return result
    },
    {
        body: t.Object({ query: t.String() }),
        detail: {
            summary: 'Test schedule tool',
            description: 'Manually execute doctor schedule tool and return results'
        }
    }
)

adminController.post(
    '/tools/doctor-search',
    async ({ body }) => {
        const doctor = await findDoctor(body.query)
        return { found: !!doctor, doctor }
    },
    {
        body: t.Object({ query: t.String() }),
        detail: {
            summary: 'Test doctor search',
            description: 'Search for a doctor by name/specialization'
        }
    }
)

adminController.post(
    '/tools/ask',
    async ({ body }) => {
        try {
            const ctx = body.senderId
                ? { conversationId: BigInt(body.conversationId ?? 0), senderId: body.senderId }
                : undefined
            const result = await runPipeline(body.question, ctx, true)
            return result
        } catch (err) {
            return { error: String(err) }
        }
    },
    {
        body: t.Object({
            question: t.String(),
            senderId: t.Optional(t.String()),
            conversationId: t.Optional(t.String())
        }),
        detail: {
            summary: 'Ask with tools',
            description: 'Run full pipeline with tool integration (verbose mode)'
        }
    }
)

adminController.post(
    '/tools/clear-memory',
    async ({ body, set }) => {
        const conversationId = BigInt(body.conversationId)

        const conv = await db
            .select({ id: conversations.id, senderId: conversations.senderId })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .then((rows) => rows[0])

        if (!conv) {
            return status(404, { error: 'Conversation not found' })
        }

        const messageCount = await db
            .select({ count: count() })
            .from(messages)
            .where(eq(messages.conversationId, conversationId))
            .then((rows) => Number(rows[0].count))

        await db.delete(messages).where(eq(messages.conversationId, conversationId))

        await db
            .update(conversations)
            .set({ summary: null, messageCount: 0, metadata: null, updatedAt: new Date() })
            .where(eq(conversations.id, conversationId))

        const clearPatient = body.clearPatient ?? true
        if (clearPatient) {
            await db
                .update(patients)
                .set({
                    name: null,
                    citizenship: null,
                    phone: null,
                    preferredLang: null,
                    preferredBranch: null,
                    preferredBranchRef1cId: null,
                    hasBookedConsultation: false,
                    bookingNudgeOffered: false,
                    nameSource: null,
                    nameChangeOffered: false,
                    updatedAt: new Date()
                })
                .where(eq(patients.senderId, conv.senderId))
        }

        return {
            success: true as const,
            conversationId: conversationId.toString(),
            clearedMessages: messageCount,
            clearedPatient: clearPatient
        }
    },
    {
        body: t.Object({
            conversationId: t.String(),
            clearPatient: t.Optional(t.Boolean({ default: true }))
        }),
        detail: {
            summary: 'Clear conversation memory',
            description:
                'Deletes conversation messages, resets summary/messageCount, and optionally clears patient data.'
        }
    }
)

// ─── Services (prices db) ─────────────────────

adminController.get(
    '/services',
    async ({ query: { q, limit } }) => {
        const rows = await db
            .select({
                id: services.id,
                ref1cId: services.ref1cId,
                name: services.name,
                price: services.price,
                durationMinutes: services.durationMinutes,
                branchRef1cId: services.branchRef1cId,
                priceListId: services.priceListId,
                citizenship: services.citizenship,
                updatedAt: services.updatedAt
            })
            .from(services)
            .where(q ? like(services.name, `%${q}%`) : sql`TRUE`)
            .orderBy(services.name)
            .limit(limit ?? 50)

        const total = await db
            .select({ count: count() })
            .from(services)
            .where(q ? like(services.name, `%${q}%`) : sql`TRUE`)
            .then((r) => Number(r[0].count))

        return { services: rows, total, query: q ?? null }
    },
    {
        query: t.Object({
            q: t.Optional(t.String()),
            limit: t.Optional(t.Numeric({ default: 50, maximum: 200 }))
        }),
        detail: {
            summary: 'List/ search services',
            description: 'Browse or search the services price database'
        }
    }
)
