import Elysia, { status } from 'elysia'

import * as models from './model'
import { InstagramWebhookService } from './service'

export const instagramWebhookController = new Elysia({
    name: 'module.webhook.instagram',
    prefix: '/webhook/instagram',
    detail: { tags: ['Webhook'] }
})
    .decorate('instagramWebhookService', new InstagramWebhookService())
    .model(models)
    .post(
        '/subscribe',
        async ({ instagramWebhookService }) => {
            return await instagramWebhookService.subscribePage()
        },
        {
            response: {
                200: 'subscribeResponse200',
                400: 'subscribeErrorResponse400'
            },
            detail: {
                summary: 'Subscribe page to webhook',
                description: 'Subscribes the Facebook Page to messages and the Instagram Business Account to comments,mentions'
            }
        }
    )
    .get(
        '/',
        ({ query, set, instagramWebhookService }) => {
            const result = instagramWebhookService.verifyWebhook(query['hub.mode'], query['hub.verify_token'], query['hub.challenge'])

            if (result.ok) {
                set.headers['Content-Type'] = 'text/plain'
                return result.challenge
            }

            return status(403, result.error)
        },
        {
            query: 'webhookVerifyQuery',
            response: {
                200: 'webhookChallengeResponse200',
                403: 'webhookErrorResponse403'
            },
            detail: {
                summary: 'Webhook verification',
                description: 'Verify Instagram webhook subscription'
            }
        }
    )
    .post(
        '/',
        ({ body, instagramWebhookService }) => {
            instagramWebhookService.processPayload(body)
            return { status: 'ok' }
        },
        {
            body: 'instagramWebhookPayload',
            response: {
                200: 'webhookEventResponse200'
            },
            detail: {
                summary: 'Webhook event receiver',
                description: 'Receive Instagram webhook events'
            }
        }
    )
