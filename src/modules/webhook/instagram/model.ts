import * as v from 'valibot'

const instagramUserRef = v.object({
    id: v.optional(v.string()),
    username: v.optional(v.string())
})

const instagramAttachmentPayload = v.object({
    url: v.optional(v.string()),
    is_reusable: v.optional(v.boolean())
})

const instagramAttachment = v.object({
    type: v.optional(v.string()),
    payload: v.optional(instagramAttachmentPayload)
})

const instagramMessage = v.object({
    mid: v.optional(v.string()),
    text: v.optional(v.string()),
    is_echo: v.optional(v.boolean()),
    attachments: v.optional(v.array(instagramAttachment))
})

export const webhookVerifyQuery = v.object({
    'hub.mode': v.optional(v.string()),
    'hub.verify_token': v.optional(v.string()),
    'hub.challenge': v.optional(v.string())
})

const instagramChangeAttachment = v.object({
    type: v.optional(v.string()),
    payload: v.optional(instagramAttachmentPayload)
})

const instagramChangeMessage = v.object({
    text: v.optional(v.string()),
    attachments: v.optional(v.array(instagramChangeAttachment))
})

const instagramChangeValue = v.object({
    from: v.optional(instagramUserRef),
    to: v.optional(instagramUserRef),
    message: v.optional(instagramChangeMessage),
    mid: v.optional(v.string()),
    is_echo: v.optional(v.boolean()),
    id: v.optional(v.string()),
    comment_id: v.optional(v.string()),
    media_id: v.optional(v.string()),
    text: v.optional(v.string())
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
                            value: v.optional(instagramChangeValue)
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
    page: v.unknown(),
    ig: v.nullable(v.unknown()),
    igError: v.nullable(v.string()),
    hint: v.nullable(v.string())
})

export const subscribeErrorResponse400 = v.object({
    error: v.string(),
    fbCode: v.optional(v.number()),
    hint: v.optional(v.string())
})

export type WebhookErrorResponse403 = v.InferOutput<typeof webhookErrorResponse403>
export type WebhookEventResponse200 = v.InferOutput<typeof webhookEventResponse200>
export type SubscribeResponse200 = v.InferOutput<typeof subscribeResponse200>
export type SubscribeErrorResponse400 = v.InferOutput<typeof subscribeErrorResponse400>
export type WebhookVerifyQuery = v.InferOutput<typeof webhookVerifyQuery>
export type InstagramWebhookPayload = v.InferOutput<typeof instagramWebhookPayload>
