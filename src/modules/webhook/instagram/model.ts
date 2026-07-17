import * as v from 'valibot'

export const webhookChallengeResponse200 = v.string()

export const webhookErrorResponse403 = v.object({
    status: v.literal('error'),
    message: v.string()
})

export const webhookEventResponse200 = v.object({
    status: v.literal('ok')
})

export const subscribeResponse200 = v.object({
    success: v.literal(true),
    response: v.unknown(),
    hint: v.nullable(v.string())
})

export const subscribeErrorResponse400 = v.object({
    error: v.string(),
    hint: v.optional(v.string())
})

export type WebhookErrorResponse403 = v.InferOutput<typeof webhookErrorResponse403>
export type WebhookEventResponse200 = v.InferOutput<typeof webhookEventResponse200>
export type SubscribeResponse200 = v.InferOutput<typeof subscribeResponse200>
export type SubscribeErrorResponse400 = v.InferOutput<typeof subscribeErrorResponse400>
