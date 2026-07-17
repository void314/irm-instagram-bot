import Elysia, { status } from 'elysia'

import {
    instagramWebhookPayload,
    subscribeErrorResponse400,
    subscribeResponse200,
    webhookChallengeResponse200,
    webhookErrorResponse403,
    webhookEventResponse200,
    webhookVerifyQuery
} from './model'
import { InstagramWebhookService } from './service'

const instagramWebhookService = new InstagramWebhookService()

export const instagramWebhookController = new Elysia({
    name: 'module.webhook.instagram',
    prefix: '/webhook/instagram',
    detail: { tags: ['Webhook'] }
})
    .post(
        '/subscribe',
        async () => {
            const result = await instagramWebhookService.subscribePage()

            if ('error' in result) {
                return status(400, result)
            }

            return result
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
            const result = instagramWebhookService.verifyWebhook(
                query['hub.mode'],
                query['hub.verify_token'],
                query['hub.challenge']
            )

            if (result.ok) {
                set.headers['Content-Type'] = 'text/plain'
                return result.challenge
            }

            return status(403, result.error)
        },
        {
            query: webhookVerifyQuery,
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
    .post('/', ({ body }) => instagramWebhookService.processPayload(body), {
        body: instagramWebhookPayload,
        response: {
            200: webhookEventResponse200
        },
        detail: {
            summary: 'Webhook event receiver',
            description: 'Receive Instagram webhook events'
        }
    })
