import { env } from '../../../config/constants'
import type {
    InstagramWebhookPayload,
    SubscribeErrorResponse400,
    SubscribeResponse200,
    WebhookErrorResponse403,
    WebhookEventResponse200
} from './model'

type SendMessageResult =
    | {
          status: 'ok'
          recipient_id?: string
          message_id?: string
      }
    | {
          status: 'error'
          message: string
      }

type WebhookVerificationResult =
    | {
          ok: true
          challenge: string
      }
    | {
          ok: false
          error: WebhookErrorResponse403
      }

const WEBHOOK_SUCCESS_RESPONSE: WebhookEventResponse200 = { status: 'ok' }
const SUBSCRIBE_PERMISSION_HINT = [
    'Requires pages_messaging permission.',
    'Get a fresh token via POST /api/auth/facebook/token-from-user'
].join(' ')

export class InstagramMessagingService {
    public async sendTextMessage(recipientId: string, text: string): Promise<SendMessageResult> {
        if (!env.FACEBOOK_PAGE_ID) {
            return { status: 'error', message: 'Missing FACEBOOK_PAGE_ID' }
        }

        if (!env.FACEBOOK_PAGE_ACCESS_TOKEN) {
            return { status: 'error', message: 'Missing FACEBOOK_PAGE_ACCESS_TOKEN' }
        }

        const url = new URL(
            `https://graph.facebook.com/${env.FACEBOOK_GRAPH_API_VERSION}/${env.FACEBOOK_PAGE_ID}/messages`
        )
        url.searchParams.set('access_token', env.FACEBOOK_PAGE_ACCESS_TOKEN)

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                recipient: { id: recipientId },
                message: { text }
            })
        })

        const data = (await response.json()) as { error?: { message?: string } } & {
            recipient_id?: string
            message_id?: string
        }

        if (!response.ok) {
            return {
                status: 'error',
                message: data?.error?.message || 'Instagram messaging request failed'
            }
        }

        return {
            status: 'ok',
            recipient_id: data.recipient_id,
            message_id: data.message_id
        }
    }
}

export class InstagramWebhookService {
    constructor(private readonly instagramMessagingService = new InstagramMessagingService()) {}

    public async subscribePage(): Promise<SubscribeResponse200 | SubscribeErrorResponse400> {
        if (!env.FACEBOOK_PAGE_ID || !env.FACEBOOK_PAGE_ACCESS_TOKEN) {
            return { error: 'FACEBOOK_PAGE_ID or FACEBOOK_PAGE_ACCESS_TOKEN not configured' }
        }

        const base = `https://graph.facebook.com/${env.FACEBOOK_GRAPH_API_VERSION || 'v25.0'}`
        const url = new URL(`${base}/${env.FACEBOOK_PAGE_ID}/subscribed_apps`)
        url.searchParams.set('subscribed_fields', 'messages')
        url.searchParams.set('access_token', env.FACEBOOK_PAGE_ACCESS_TOKEN)

        const response = await fetch(url, { method: 'POST' })
        const data = await response.json()

        if (!response.ok) {
            return {
                error: 'Failed to subscribe page to webhook',
                hint: SUBSCRIBE_PERMISSION_HINT
            }
        }

        return {
            success: true,
            response: data,
            hint: null
        }
    }

    public verifyWebhook(mode?: string, token?: string, challenge?: string): WebhookVerificationResult {
        if (!env.WEBHOOK_VERIFY_TOKEN) {
            return {
                ok: false,
                error: { status: 'error', message: 'Missing WEBHOOK_VERIFY_TOKEN' }
            }
        }

        if (mode === 'subscribe' && token === env.WEBHOOK_VERIFY_TOKEN && typeof challenge === 'string') {
            return {
                ok: true,
                challenge
            }
        }

        return {
            ok: false,
            error: { status: 'error', message: 'Invalid webhook verification token' }
        }
    }

    public async processPayload(payload: InstagramWebhookPayload): Promise<WebhookEventResponse200> {
        const entries = payload.entry || []

        for (const entry of entries) {
            await this.processEntry(entry)
        }

        return WEBHOOK_SUCCESS_RESPONSE
    }

    private async processEntry(entry: NonNullable<InstagramWebhookPayload['entry']>[number]) {
        const messagingEvents = entry.messaging || []
        const changeEvents = entry.changes || []

        for (const event of messagingEvents) {
            await this.processMessagingEvent(entry.id, event)
        }

        for (const change of changeEvents) {
            await this.processChangeEvent(change)
        }
    }

    private async processMessagingEvent(
        entryId: string | undefined,
        event: NonNullable<NonNullable<InstagramWebhookPayload['entry']>[number]['messaging']>[number]
    ) {
        const senderId = event.sender?.id
        const recipientId = event.recipient?.id
        const message = event.message
        const isEcho = message?.is_echo

        if (!senderId || !message || isEcho) {
            return
        }

        if (env.INSTAGRAM_BUSINESS_ID && senderId === env.INSTAGRAM_BUSINESS_ID) {
            return
        }

        const isBusinessRecipient =
            env.INSTAGRAM_BUSINESS_ID &&
            (recipientId === env.INSTAGRAM_BUSINESS_ID || entryId === env.INSTAGRAM_BUSINESS_ID)

        if (isBusinessRecipient) {
            await this.replyWithAutoResponse(senderId)
        }
    }

    private async processChangeEvent(
        change: NonNullable<NonNullable<InstagramWebhookPayload['entry']>[number]['changes']>[number]
    ) {
        if (change.field !== 'messages') {
            return
        }

        const senderId = change.value?.from?.id
        const recipientId = change.value?.to?.id
        const isEcho = change.value?.is_echo

        if (!senderId || isEcho) {
            return
        }

        if (env.INSTAGRAM_BUSINESS_ID && senderId === env.INSTAGRAM_BUSINESS_ID) {
            return
        }

        if (recipientId && env.INSTAGRAM_BUSINESS_ID && recipientId === env.INSTAGRAM_BUSINESS_ID) {
            await this.replyWithAutoResponse(senderId)
        }
    }

    private async replyWithAutoResponse(recipientId: string) {
        const result = await this.instagramMessagingService.sendTextMessage(
            recipientId,
            env.WEBHOOK_AUTO_REPLY_TEXT
        )

        if (result.status === 'error') {
            console.error('[Webhook] Instagram reply failed:', result.message)
            return
        }

        console.log('[Webhook] Instagram reply sent:', result.message_id || result.recipient_id)
    }
}
