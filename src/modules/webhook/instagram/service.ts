import { status } from 'elysia'

import { eq } from 'drizzle-orm'

import { runPipeline } from '../../../agents/orchestrator'
import { env } from '../../../config/constants'
import { db } from '../../../db/client'
import { accounts, conversations, messages } from '../../../db/schema'
import { log } from '../../../services/logger'
import { transcribeAudio } from '../../../services/transcription'
import { ensurePatient, fetchInstagramUserInfo, updatePatient } from '../../../services/rag/patient'
import { TokenService } from '../../tokens'
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

const tokenService = new TokenService()

const INSTAGRAM_MAX_LENGTH = 1000

function splitIntoChunks(text: string, maxLen: number = INSTAGRAM_MAX_LENGTH): string[] {
    const chunks: string[] = []
    let remaining = text.trim()
    while (remaining.length > maxLen) {
        let cut = remaining.lastIndexOf('\n', maxLen)
        if (cut <= 0) cut = remaining.lastIndexOf(' ', maxLen)
        if (cut <= 0) cut = maxLen
        chunks.push(remaining.slice(0, cut).trimEnd())
        remaining = remaining.slice(cut).trimStart()
    }
    if (remaining) chunks.push(remaining)
    return chunks
}

export class InstagramMessagingService {
    public async sendTextMessage(recipientId: string, text: string): Promise<SendMessageResult> {
        let pageToken: string | null = null

        if (env.INSTAGRAM_BUSINESS_ID) {
            pageToken = await tokenService.getDecryptedToken(env.INSTAGRAM_BUSINESS_ID)
        }

        if (!pageToken) {
            return { status: 'error', message: 'No page access token available' }
        }

        if (!env.FACEBOOK_PAGE_ID) {
            return { status: 'error', message: 'Missing FACEBOOK_PAGE_ID' }
        }

        const url = new URL(
            `https://graph.facebook.com/${env.FACEBOOK_GRAPH_API_VERSION}/${env.FACEBOOK_PAGE_ID}/messages`
        )
        url.searchParams.set('access_token', pageToken)

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

    public async subscribePage() {
        let pageToken: string | null = null

        if (env.INSTAGRAM_BUSINESS_ID) {
            pageToken = await tokenService.getDecryptedToken(env.INSTAGRAM_BUSINESS_ID)
        }

        if (!env.FACEBOOK_PAGE_ID || !pageToken) {
            return status(400, {
                error: 'FACEBOOK_PAGE_ID or page access token not configured'
            } as SubscribeErrorResponse400)
        }

        const base = `https://graph.facebook.com/${env.FACEBOOK_GRAPH_API_VERSION || 'v25.0'}`
        const url = new URL(`${base}/${env.FACEBOOK_PAGE_ID}/subscribed_apps`)
        url.searchParams.set('subscribed_fields', 'messages')
        url.searchParams.set('access_token', pageToken)

        const response = await fetch(url, { method: 'POST' })
        const data = await response.json()

        if (!response.ok) {
            return status(400, {
                error: 'Failed to subscribe page to webhook',
                hint: SUBSCRIBE_PERMISSION_HINT
            } as SubscribeErrorResponse400)
        }

        return {
            success: true,
            response: data,
            hint: null
        } as SubscribeResponse200
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
        try {
            const entries = payload.entry || []

            log.info(
                { module: 'webhook', object: payload.object, entryCount: entries.length },
                '[webhook] payload received'
            )

            for (const entry of entries) {
                await this.processEntry(entry)
            }
        } catch (err) {
            log.error(
                { module: 'webhook', error: String(err) },
                '[webhook] background processing failed'
            )
        }

        return WEBHOOK_SUCCESS_RESPONSE
    }

    private async processEntry(entry: NonNullable<InstagramWebhookPayload['entry']>[number]) {
        const messagingEvents = entry.messaging || []
        const changeEvents = entry.changes || []

        log.info(
            {
                module: 'webhook',
                entryId: entry.id,
                messagingCount: messagingEvents.length,
                changeCount: changeEvents.length
            },
            '[webhook] entry'
        )

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
        const text = message?.text

        if (!senderId || !message || isEcho) {
            return
        }

        if (env.INSTAGRAM_BUSINESS_ID && senderId === env.INSTAGRAM_BUSINESS_ID) {
            return
        }

        let finalText = text ?? null
        let messageMetadata: Record<string, unknown> | undefined

        if (!finalText) {
            const attachments = message.attachments || []
            const audioAttachment = attachments.find((a) => a.type === 'audio')

            if (audioAttachment?.payload?.url && env.INSTAGRAM_BUSINESS_ID) {
                try {
                    const pageToken = await tokenService.getDecryptedToken(env.INSTAGRAM_BUSINESS_ID)
                    if (pageToken) {
                        finalText = await transcribeAudio(audioAttachment.payload.url, pageToken)
                        messageMetadata = { type: 'voice', audioUrl: audioAttachment.payload.url }
                        log.info(
                            { module: 'webhook', senderId, transcriptLength: finalText.length },
                            '[webhook] voice message transcribed'
                        )
                    }
                } catch (err) {
                    log.error(
                        { module: 'webhook', senderId, error: String(err) },
                        '[webhook] voice transcription failed'
                    )
                }
            }
        }

        const isBusinessRecipient =
            env.INSTAGRAM_BUSINESS_ID &&
            (recipientId === env.INSTAGRAM_BUSINESS_ID || entryId === env.INSTAGRAM_BUSINESS_ID)

        if (isBusinessRecipient) {
            log.info({ module: 'webhook', senderId, recipientId }, '[webhook] messaging event handled')
            await this.handleIncomingMessage(senderId, finalText, messageMetadata)
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
        const text = change.value?.message?.text

        if (!senderId || isEcho) {
            return
        }

        if (env.INSTAGRAM_BUSINESS_ID && senderId === env.INSTAGRAM_BUSINESS_ID) {
            return
        }

        let finalText = text ?? null
        let messageMetadata: Record<string, unknown> | undefined

        if (!finalText) {
            const attachments = change.value?.message?.attachments || []
            const audioAttachment = attachments.find((a) => a.type === 'audio')

            if (audioAttachment?.payload?.url && env.INSTAGRAM_BUSINESS_ID) {
                try {
                    const pageToken = await tokenService.getDecryptedToken(env.INSTAGRAM_BUSINESS_ID)
                    if (pageToken) {
                        finalText = await transcribeAudio(audioAttachment.payload.url, pageToken)
                        messageMetadata = { type: 'voice', audioUrl: audioAttachment.payload.url }
                        log.info(
                            { module: 'webhook', senderId, transcriptLength: finalText.length },
                            '[webhook] voice message transcribed'
                        )
                    }
                } catch (err) {
                    log.error(
                        { module: 'webhook', senderId, error: String(err) },
                        '[webhook] voice transcription failed'
                    )
                }
            }
        }

        if (recipientId && env.INSTAGRAM_BUSINESS_ID && recipientId === env.INSTAGRAM_BUSINESS_ID) {
            log.info({ module: 'webhook', senderId, recipientId }, '[webhook] change event handled')
            await this.handleIncomingMessage(senderId, finalText, messageMetadata)
        }
    }

    private async handleIncomingMessage(senderId: string, text: string | null, messageMetadata?: Record<string, unknown>) {
        log.info(
            { module: 'webhook', senderId, hasText: !!text, textLength: text?.length ?? 0 },
            '[webhook] incoming message'
        )

        const [convRow, patient] = await Promise.all([
            db
                .select()
                .from(conversations)
                .where(eq(conversations.senderId, senderId))
                .then((rows) => rows[0]),
            ensurePatient(senderId)
        ])

        let conv = convRow
        const isNewConversation = !conv

        if (isNewConversation && env.INSTAGRAM_BUSINESS_ID) {
            const [newConv] = await db
                .insert(conversations)
                .values({
                    senderId,
                    businessId: env.INSTAGRAM_BUSINESS_ID
                })
                .returning()
            conv = newConv

            log.info({ module: 'webhook', conversationId: conv.id.toString() }, '[webhook] conversation created')
        }

        if (!conv) {
            console.error('[Webhook] Cannot create conversation — missing INSTAGRAM_BUSINESS_ID')
            return
        }

        // Fire-and-forget Instagram user info enrichment (non-blocking)
        if (isNewConversation) {
            tokenService.getDecryptedToken(env.INSTAGRAM_BUSINESS_ID!).then((token) => {
                if (!token) return
                return fetchInstagramUserInfo(senderId, token)
            }).then((igInfo) => {
                if (!igInfo) return
                const updates: Parameters<typeof updatePatient>[1] = {
                    instagramName: igInfo.name,
                    instagramUsername: igInfo.username
                }
                if (!patient.name && !patient.nameSource) {
                    updates.nameSource = 'instagram'
                }
                return updatePatient(senderId, updates)
            }).catch((err) => {
                log.warn({ module: 'webhook', error: String(err) }, '[webhook] instagram info fetch failed')
            })
        }

        if (env.INSTAGRAM_BUSINESS_ID && text) {
            db.insert(messages).values({
                conversationId: conv.id,
                fromId: senderId,
                text,
                metadata: messageMetadata
            }).then(() => {
                log.info({ module: 'webhook', conversationId: conv.id.toString() }, '[webhook] message stored')
            }).catch((err) => {
                log.error({ module: 'webhook', error: String(err) }, '[webhook] message insert failed')
            })
        }

        const question = text || env.WEBHOOK_AUTO_REPLY_TEXT

        try {
            const { answer, intent, needsClarification } = await runPipeline(question, {
                conversationId: conv.id,
                senderId
            })

            log.info(
                {
                    module: 'webhook',
                    conversationId: conv.id.toString(),
                    intent,
                    needsClarification,
                    answerLength: answer.length
                },
                '[webhook] pipeline result'
            )

            const chunks = splitIntoChunks(answer)

            // Save bot answer in background — don't block sending
            if (env.INSTAGRAM_BUSINESS_ID && answer) {
                db.insert(messages).values({
                    conversationId: conv.id,
                    fromId: env.INSTAGRAM_BUSINESS_ID,
                    text: answer
                }).catch((err) => {
                    log.error({ module: 'webhook', error: String(err) }, '[webhook] bot answer insert failed')
                })
            }

            let lastOk = false
            for (const chunk of chunks) {
                const result = await this.instagramMessagingService.sendTextMessage(senderId, chunk)
                if (result.status === 'error') {
                    log.error(
                        { module: 'webhook', error: result.message, chunkLength: chunk.length },
                        '[webhook] reply chunk failed'
                    )
                    lastOk = false
                    break
                }
                lastOk = true
            }

            // Fire-and-forget summary update
            if (conv.messageCount !== null && conv.messageCount % 6 === 0 && conv.messageCount > 0) {
                import('../../../services/rag/context').then(({ updateConversationSummary }) => {
                    updateConversationSummary(conv.id).catch((err) => {
                        log.error({ module: 'webhook', error: String(err) }, '[webhook] summary update failed')
                    })
                })
            }

            if (!lastOk) {
                return
            }

            log.info(
                { module: 'webhook', chunkCount: chunks.length, totalLength: answer.length, intent },
                '[webhook] reply sent'
            )
        } catch (err) {
            log.error({ module: 'webhook', error: String(err) }, '[webhook] pipeline error')

            const fallback = await this.instagramMessagingService.sendTextMessage(
                senderId,
                env.WEBHOOK_AUTO_REPLY_TEXT
            )
            if (fallback.status === 'error') {
                console.error('[Webhook] Fallback reply failed:', fallback.message)
            }
        }
    }
}
