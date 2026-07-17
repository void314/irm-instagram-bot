import * as v from 'valibot'

const instagramUserRef = v.object({
    id: v.optional(v.string()),
    username: v.optional(v.string())
})

const instagramMessage = v.object({
    mid: v.optional(v.string()),
    text: v.optional(v.string()),
    is_echo: v.optional(v.boolean())
})

export const webhookVerifyQuery = v.object({
    'hub.mode': v.optional(v.string()),
    'hub.verify_token': v.optional(v.string()),
    'hub.challenge': v.optional(v.string())
})

export const instagramWebhookPayload = v.object({
    object: v.optional(v.string()),
    entry: v.optional(
        v.array(
            v.object({
                id: v.optional(v.string()),
                time: v.optional(v.number()),
                messaging: v.optional(
                    v.array(
                        v.object({
                            sender: v.optional(instagramUserRef),
                            recipient: v.optional(instagramUserRef),
                            message: v.optional(instagramMessage)
                        })
                    )
                ),
                changes: v.optional(
                    v.array(
                        v.object({
                            field: v.optional(v.string()),
                            value: v.optional(
                                v.object({
                                    from: v.optional(instagramUserRef),
                                    to: v.optional(instagramUserRef),
                                    message: v.optional(
                                        v.object({
                                            text: v.optional(v.string())
                                        })
                                    ),
                                    mid: v.optional(v.string()),
                                    is_echo: v.optional(v.boolean())
                                })
                            )
                        })
                    )
                )
            })
        )
    )
})

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
export type WebhookVerifyQuery = v.InferOutput<typeof webhookVerifyQuery>
export type InstagramWebhookPayload = v.InferOutput<typeof instagramWebhookPayload>
