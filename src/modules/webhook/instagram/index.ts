import Elysia from 'elysia'

import { env } from '../../../config/constants'
import {
    subscribeErrorResponse400,
    subscribeResponse200,
    webhookChallengeResponse200,
    webhookErrorResponse403,
    webhookEventResponse200
} from './model'
import { InstagramMessagingService } from './service'

const WEBHOOK_SUCCESS_RESPONSE = { status: 'ok' } as const
const instagramMessagingService = new InstagramMessagingService()

type InstagramWebhookPayload = {
    object?: string
    entry?: Array<{
        id?: string
        time?: number
        messaging?: Array<{
            sender?: { id?: string }
            recipient?: { id?: string }
            message?: { mid?: string; text?: string; is_echo?: boolean }
        }>
        changes?: Array<{
            field?: string
            value?: {
                from?: { id?: string; username?: string }
                to?: { id?: string; username?: string }
                message?: { text?: string }
                mid?: string
                is_echo?: boolean
            }
        }>
    }>
}

export const instagramWebhookController = new Elysia({
    prefix: '/webhook/instagram',
    detail: { tags: ['Webhook'] }
})
    .post(
        '/subscribe',
        async () => {
            if (!env.FACEBOOK_PAGE_ID || !env.FACEBOOK_PAGE_ACCESS_TOKEN) {
                return { error: 'FACEBOOK_PAGE_ID or FACEBOOK_PAGE_ACCESS_TOKEN not configured' }
            }

            const base = `https://graph.facebook.com/${env.FACEBOOK_GRAPH_API_VERSION || 'v25.0'}`
            const url = new URL(`${base}/${env.FACEBOOK_PAGE_ID}/subscribed_apps`)
            url.searchParams.set('subscribed_fields', 'messages')
            url.searchParams.set('access_token', env.FACEBOOK_PAGE_ACCESS_TOKEN)

            const res = await fetch(url, { method: 'POST' })
            const data = await res.json()

            return {
                success: res.ok,
                response: data,
                hint: res.ok
                    ? null
                    : 'Requires pages_messaging permission. Get a fresh token via POST /api/auth/facebook/token-from-user'
            }
        },
        {
            response: {
                200: subscribeResponse200,
                400: subscribeErrorResponse400
            },
            detail: {
                summary: 'Subscribe page to webhook',
                description:
                    'Subscribes the configured Facebook Page to receive Instagram messaging events via the webhook'
            }
        }
    )
    .get(
        '/',
        ({ query, set }) => {
            const mode = query['hub.mode']
            const token = query['hub.verify_token']
            const challenge = query['hub.challenge']

            if (!env.WEBHOOK_VERIFY_TOKEN) {
                set.status = 403
                return { status: 'error', message: 'Missing WEBHOOK_VERIFY_TOKEN' }
            }

            if (mode === 'subscribe' && token === env.WEBHOOK_VERIFY_TOKEN && typeof challenge === 'string') {
                set.headers['Content-Type'] = 'text/plain'
                return challenge
            }

            set.status = 403
            return { status: 'error', message: 'Invalid webhook verification token' }
        },
        {
            response: {
                200: webhookChallengeResponse200,
                403: webhookErrorResponse403
            },
            detail: {
                summary: 'Webhook verification',
                description: 'Verify Instagram webhook subscription'
            }
        }
    )
    .post(
        '/',
        async ({ body }) => {
            let payload: InstagramWebhookPayload | null = null

            try {
                payload = (typeof body === 'string' ? JSON.parse(body) : body) as InstagramWebhookPayload
            } catch (error) {
                console.error('[Webhook] Invalid JSON payload:', (error as Error).message)
                return WEBHOOK_SUCCESS_RESPONSE
            }

            const entries = payload?.entry || []

            for (const entry of entries) {
                const messagingEvents = entry.messaging || []
                const changeEvents = entry.changes || []

                for (const event of messagingEvents) {
                    const senderId = event.sender?.id
                    const recipientId = event.recipient?.id
                    const isEcho = event.message?.is_echo
                    const message = event.message

                    if (!senderId || !message || isEcho) {
                        continue
                    }

                    if (env.INSTAGRAM_BUSINESS_ID && senderId === env.INSTAGRAM_BUSINESS_ID) {
                        continue
                    }

                    const isBusinessRecipient =
                        env.INSTAGRAM_BUSINESS_ID &&
                        (recipientId === env.INSTAGRAM_BUSINESS_ID || entry.id === env.INSTAGRAM_BUSINESS_ID)

                    if (isBusinessRecipient) {
                        const result = await instagramMessagingService.sendTextMessage(
                            senderId,
                            env.WEBHOOK_AUTO_REPLY_TEXT
                        )

                        if (result.status === 'error') {
                            console.error('[Webhook] Instagram reply failed:', result.message)
                        } else {
                            console.log(
                                '[Webhook] Instagram reply sent:',
                                result.message_id || result.recipient_id
                            )
                        }
                    }
                }

                for (const change of changeEvents) {
                    if (change.field !== 'messages') {
                        continue
                    }

                    const senderId = change.value?.from?.id
                    const recipientId = change.value?.to?.id
                    const isEcho = change.value?.is_echo

                    if (!senderId || isEcho) {
                        continue
                    }

                    if (env.INSTAGRAM_BUSINESS_ID && senderId === env.INSTAGRAM_BUSINESS_ID) {
                        continue
                    }

                    if (recipientId && env.INSTAGRAM_BUSINESS_ID && recipientId === env.INSTAGRAM_BUSINESS_ID) {
                        const result = await instagramMessagingService.sendTextMessage(
                            senderId,
                            env.WEBHOOK_AUTO_REPLY_TEXT
                        )

                        if (result.status === 'error') {
                            console.error('[Webhook] Instagram reply failed:', result.message)
                        } else {
                            console.log(
                                '[Webhook] Instagram reply sent:',
                                result.message_id || result.recipient_id
                            )
                        }
                    }
                }
            }

            return WEBHOOK_SUCCESS_RESPONSE
        },
        {
            response: {
                200: webhookEventResponse200
            },
            detail: {
                summary: 'Webhook event receiver',
                description: 'Receive Instagram webhook events'
            }
        }
    )
