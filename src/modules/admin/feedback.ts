import Elysia, { status, t } from 'elysia'

import { count, desc, eq, like, sql } from 'drizzle-orm'

import { correctionsQueue } from '../../agents/learning/scheduler'
import { db } from '../../db/client'
import { conversations, messages, patients, responseFeedback, services } from '../../db/schema'

export const feedbackController = new Elysia({
    name: 'module.admin.feedback',
    prefix: '/feedback',
    detail: { tags: ['Admin', 'Learning'] }
})

    .get(
        '/',
        async ({ query: { limit, offset, status: statusFilter } }) => {
            const query = db
                .select()
                .from(responseFeedback)
                .where(statusFilter ? eq(responseFeedback.status, statusFilter) : sql`TRUE`)

            const rows = await query
                .orderBy(desc(responseFeedback.createdAt))
                .limit(limit ?? 50)
                .offset(offset ?? 0)

            const totalQuery = db
                .select({ count: count() })
                .from(responseFeedback)
                .where(statusFilter ? eq(responseFeedback.status, statusFilter) : sql`TRUE`)

            const total = await totalQuery.then((r) => Number(r[0].count))

            return { feedback: rows, total }
        },
        {
            query: t.Object({
                limit: t.Optional(t.Numeric({ default: 50, maximum: 200 })),
                offset: t.Optional(t.Numeric({ default: 0 })),
                status: t.Optional(t.String())
            }),
            detail: {
                summary: 'List feedback',
                description: 'Returns list of AI response feedbacks'
            }
        }
    )

    .post(
        '/:id/correct',
        async ({ params: { id }, body }) => {
            const feedbackId = BigInt(id)

            // Ensure feedback exists, if not, we can create one if we have responseId, but let's assume it exists or we throw
            // Actually, if we're correcting an inline message from UI that wasn't feedbacked yet, we might need to create it.
            // The plan says "исправить ответ -> сохраняется в response_feedback"

            let feedback = await db
                .select()
                .from(responseFeedback)
                .where(eq(responseFeedback.id, feedbackId))
                .then((r) => r[0])

            if (!feedback) {
                return status(404, { error: 'Feedback not found' })
            }

            await db
                .update(responseFeedback)
                .set({
                    correctedResponse: body.correctedResponse,
                    correctionReason: body.correctionReason,
                    status: 'pending',
                    source: 'admin'
                })
                .where(eq(responseFeedback.id, feedbackId))

            await correctionsQueue.add('process', { feedbackId: id })

            return { success: true }
        },
        {
            params: t.Object({ id: t.String() }),
            body: t.Object({
                correctedResponse: t.String(),
                correctionReason: t.Optional(t.String())
            }),
            detail: {
                summary: 'Correct AI response',
                description: 'Admin corrects an AI response. Sets status to pending for learning.'
            }
        }
    )

    .post(
        '/create',
        async ({ body }) => {
            const inserted = await db
                .insert(responseFeedback)
                .values({
                    responseId: body.responseId,
                    conversationId: BigInt(body.conversationId),
                    query: body.query,
                    originalResponse: body.originalResponse,
                    correctedResponse: body.correctedResponse,
                    correctionReason: body.correctionReason,
                    status: 'pending',
                    source: 'admin'
                })
                .returning()

            await correctionsQueue.add('process', { feedbackId: inserted[0].id.toString() })

            return inserted[0]
        },
        {
            body: t.Object({
                responseId: t.Optional(t.String()),
                conversationId: t.String(),
                query: t.String(),
                originalResponse: t.String(),
                correctedResponse: t.String(),
                correctionReason: t.Optional(t.String())
            }),
            detail: {
                summary: 'Create feedback/correction',
                description: 'Create a new feedback entry when admin corrects a response inline.'
            }
        }
    )
