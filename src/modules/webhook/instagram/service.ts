import { status } from 'elysia'

import { eq } from 'drizzle-orm'

import { runPipeline } from '../../../agents/orchestrator'
import { env } from '../../../config/constants'
import { db } from '../../../db/client'
import { accounts, comments, conversations, messages } from '../../../db/schema'
import { log } from '../../../services/logger'
import { ensurePatient, fetchInstagramUserInfo, updatePatient } from '../../../services/rag/patient'
import { describeImage, transcribeAudio } from '../../../services/transcription'
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

export class InstagramCommentService {
    public async replyToComment(commentId: string, text: string): Promise<SendMessageResult> {
        let pageToken: string | null = null

        if (env.INSTAGRAM_BUSINESS_ID) {
            pageToken = await tokenService.getDecryptedToken(env.INSTAGRAM_BUSINESS_ID)
        }

        if (!pageToken) {
            return { status: 'error', message: 'No page access token available' }
        }

        const url = new URL(`https://graph.facebook.com/${env.FACEBOOK_GRAPH_API_VERSION}/${commentId}/replies`)
        url.searchParams.set('access_token', pageToken)

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ message: text })
        })

        const data = (await response.json()) as { error?: { message?: string } } & {
            id?: string
        }

        if (!response.ok) {
            return {
                status: 'error',
                message: data?.error?.message || 'Instagram comment reply failed'
            }
        }

        return {
            status: 'ok',
            recipient_id: commentId,
            message_id: data.id
        }
    }

    public async isOwnMedia(mediaId: string): Promise<boolean> {
        if (!env.INSTAGRAM_BUSINESS_ID) return false

        let pageToken: string | null = null
        if (env.INSTAGRAM_BUSINESS_ID) {
            pageToken = await tokenService.getDecryptedToken(env.INSTAGRAM_BUSINESS_ID)
        }
        if (!pageToken) return false

        const url = new URL(`https://graph.facebook.com/${env.FACEBOOK_GRAPH_API_VERSION}/${mediaId}`)
        url.searchParams.set('access_token', pageToken)
        url.searchParams.set('fields', 'owner')

        try {
            const response = await fetch(url)
            if (!response.ok) return false
            const data = (await response.json()) as { owner?: { id?: string } }
            return data?.owner?.id === env.INSTAGRAM_BUSINESS_ID
        } catch {
            return false
        }
    }
}

export class InstagramWebhookService {
    constructor(
        private readonly instagramMessagingService = new InstagramMessagingService(),
        private readonly instagramCommentService = new InstagramCommentService()
    ) {}

    private async subscribeField(
        entityId: string,
        fields: string,
        token: string
    ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
        const base = `https://graph.facebook.com/${env.FACEBOOK_GRAPH_API_VERSION || 'v25.0'}`
        const url = new URL(`${base}/${entityId}/subscribed_apps`)
        url.searchParams.set('subscribed_fields', fields)
        url.searchParams.set('access_token', token)

        const response = await fetch(url, { method: 'POST' })
        const data = await response.json()

        if (!response.ok) {
            const fbError = (data as { error?: { message?: string } })?.error
            return { ok: false, error: fbError?.message || 'Subscription failed' }
        }

        return { ok: true, data }
    }

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

        const pageResult = await this.subscribeField(env.FACEBOOK_PAGE_ID, 'messages', pageToken)
        if (!pageResult.ok) {
            return status(400, {
                error: pageResult.error,
                hint: SUBSCRIBE_PERMISSION_HINT
            } as SubscribeErrorResponse400)
        }

        let igResult: { ok: true; data: unknown } | { ok: false; error: string } | null = null

        if (env.INSTAGRAM_BUSINESS_ID) {
            igResult = await this.subscribeField(env.INSTAGRAM_BUSINESS_ID, 'comments,mentions', pageToken)
        }

        return {
            success: true,
            page: pageResult.data,
            ig: igResult && 'data' in igResult ? igResult.data : null,
            igError: igResult && 'error' in igResult ? igResult.error : null,
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
            log.error({ module: 'webhook', error: String(err) }, '[webhook] background processing failed')
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
        const mid = message?.mid

        if (!senderId || !message || isEcho) {
            return
        }

        if (env.INSTAGRAM_BUSINESS_ID && senderId === env.INSTAGRAM_BUSINESS_ID) {
            return
        }

        let finalText = text ?? null
        let messageMetadata: Record<string, unknown> | undefined

        const attachments = message.attachments || []

        // Audio transcription
        if (!finalText) {
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

        // Image description
        const imageAttachment = attachments.find((a) => a.type === 'image')
        if (imageAttachment?.payload?.url && env.INSTAGRAM_BUSINESS_ID) {
            try {
                const pageToken = await tokenService.getDecryptedToken(env.INSTAGRAM_BUSINESS_ID)
                if (pageToken) {
                    const description = await describeImage(imageAttachment.payload.url, pageToken)
                    const imageMeta = { type: 'image', imageUrl: imageAttachment.payload.url }

                    if (finalText) {
                        finalText = `${finalText}\n\n[User also sent an image: ${description}]`
                        messageMetadata = { ...(messageMetadata || {}), ...imageMeta }
                    } else {
                        finalText = description
                        messageMetadata = imageMeta
                    }

                    log.info(
                        { module: 'webhook', senderId, descriptionLength: description.length },
                        '[webhook] image described'
                    )
                }
            } catch (err) {
                log.error(
                    { module: 'webhook', senderId, error: String(err) },
                    '[webhook] image description failed'
                )
            }
        }

        const isBusinessRecipient =
            env.INSTAGRAM_BUSINESS_ID &&
            (recipientId === env.INSTAGRAM_BUSINESS_ID || entryId === env.INSTAGRAM_BUSINESS_ID)

        if (isBusinessRecipient) {
            log.info({ module: 'webhook', senderId, recipientId }, '[webhook] messaging event handled')
            await this.handleIncomingMessage(senderId, finalText, messageMetadata, mid)
        }
    }

    private async processChangeEvent(
        change: NonNullable<NonNullable<InstagramWebhookPayload['entry']>[number]['changes']>[number]
    ) {
        if (change.field === 'messages') {
            await this.processMessageChange(change)
        } else if (change.field === 'comments') {
            await this.processCommentEvent(change)
        } else if (change.field === 'mentions') {
            await this.processMentionEvent(change)
        }
    }

    private async processMessageChange(
        change: NonNullable<NonNullable<InstagramWebhookPayload['entry']>[number]['changes']>[number]
    ) {
        const changeValue = change.value as
            | {
                  from?: { id?: string }
                  to?: { id?: string }
                  is_echo?: boolean
                  message?: { text?: string; attachments?: Array<{ type?: string; payload?: { url?: string } }> }
                  mid?: string
              }
            | undefined

        const senderId = changeValue?.from?.id
        const recipientId = changeValue?.to?.id
        const isEcho = changeValue?.is_echo
        const text = changeValue?.message?.text
        const mid = changeValue?.mid

        if (!senderId || isEcho) {
            return
        }

        if (env.INSTAGRAM_BUSINESS_ID && senderId === env.INSTAGRAM_BUSINESS_ID) {
            return
        }

        let finalText = text ?? null
        let messageMetadata: Record<string, unknown> | undefined

        const attachments = changeValue?.message?.attachments || []

        // Audio transcription
        if (!finalText) {
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

        // Image description
        const imageAttachment = attachments.find((a) => a.type === 'image')
        if (imageAttachment?.payload?.url && env.INSTAGRAM_BUSINESS_ID) {
            try {
                const pageToken = await tokenService.getDecryptedToken(env.INSTAGRAM_BUSINESS_ID)
                if (pageToken) {
                    const description = await describeImage(imageAttachment.payload.url, pageToken)
                    const imageMeta = { type: 'image', imageUrl: imageAttachment.payload.url }

                    if (finalText) {
                        finalText = `${finalText}\n\n[User also sent an image: ${description}]`
                        messageMetadata = { ...(messageMetadata || {}), ...imageMeta }
                    } else {
                        finalText = description
                        messageMetadata = imageMeta
                    }

                    log.info(
                        { module: 'webhook', senderId, descriptionLength: description.length },
                        '[webhook] image described'
                    )
                }
            } catch (err) {
                log.error(
                    { module: 'webhook', senderId, error: String(err) },
                    '[webhook] image description failed'
                )
            }
        }

        if (recipientId && env.INSTAGRAM_BUSINESS_ID && recipientId === env.INSTAGRAM_BUSINESS_ID) {
            log.info({ module: 'webhook', senderId, recipientId }, '[webhook] change event handled')
            await this.handleIncomingMessage(senderId, finalText, messageMetadata, mid)
        }
    }

    private async processCommentEvent(
        change: NonNullable<NonNullable<InstagramWebhookPayload['entry']>[number]['changes']>[number]
    ) {
        const value = change.value as
            | {
                  id?: string
                  media_id?: string
                  text?: string
                  from?: { id?: string; username?: string }
              }
            | undefined

        const commentId = value?.id
        const mediaId = value?.media_id
        const text = value?.text
        const senderId = value?.from?.id
        const senderUsername = value?.from?.username

        if (!commentId || !senderId) return

        if (env.INSTAGRAM_BUSINESS_ID && senderId === env.INSTAGRAM_BUSINESS_ID) return
        if (!mediaId) return

        log.info({ module: 'webhook', commentId, mediaId, senderId }, '[webhook] comment event received')

        const ownMedia = await this.instagramCommentService.isOwnMedia(mediaId)
        if (!ownMedia) {
            log.info(
                { module: 'webhook', commentId, mediaId },
                '[webhook] comment on non-owned media, skipping reply'
            )
            await this.storeComment(commentId, mediaId, senderId, senderUsername, text, null, false, null)
            return
        }

        const isQuestion = this.isQuestionText(text || '')
        log.info({ module: 'webhook', commentId, isQuestion }, '[webhook] comment classified')

        if (!isQuestion) {
            await this.storeComment(commentId, mediaId, senderId, senderUsername, text, null, false, null)
            return
        }

        await this.handleCommentWithReply(commentId, mediaId, senderId, senderUsername, text || '')
    }

    private async processMentionEvent(
        change: NonNullable<NonNullable<InstagramWebhookPayload['entry']>[number]['changes']>[number]
    ) {
        const value = change.value as
            | {
                  comment_id?: string
                  media_id?: string
                  text?: string
                  from?: { id?: string; username?: string }
              }
            | undefined

        const commentId = value?.comment_id
        const mediaId = value?.media_id
        const text = value?.text
        const senderId = value?.from?.id
        const senderUsername = value?.from?.username

        if (!commentId || !senderId) return

        if (env.INSTAGRAM_BUSINESS_ID && senderId === env.INSTAGRAM_BUSINESS_ID) return

        log.info({ module: 'webhook', commentId, mediaId, senderId, text }, '[webhook] mention event received')

        if (!mediaId) {
            await this.storeComment(commentId, null, senderId, senderUsername, text, null, false, null)
            return
        }

        const ownMedia = await this.instagramCommentService.isOwnMedia(mediaId)
        if (!ownMedia) {
            log.info(
                { module: 'webhook', commentId, mediaId },
                '[webhook] mention on non-owned media, storing only'
            )
            await this.storeComment(commentId, mediaId, senderId, senderUsername, text, null, false, null)
            return
        }

        const isQuestion = this.isQuestionText(text || '')
        log.info({ module: 'webhook', commentId, isQuestion }, '[webhook] mention classified')

        if (!isQuestion) {
            await this.storeComment(commentId, mediaId, senderId, senderUsername, text, null, false, null)
            return
        }

        await this.handleCommentWithReply(commentId, mediaId, senderId, senderUsername, text || '')
    }

    private isQuestionText(text: string): boolean {
        const trimmed = text.trim()
        if (trimmed.endsWith('?')) return true
        if (trimmed.endsWith('؟')) return true
        if (trimmed.length > 20) return true
        return false
    }

    private async storeComment(
        commentId: string,
        mediaId: string | null,
        senderId: string,
        senderUsername: string | null | undefined,
        text: string | null | undefined,
        parentId: string | null,
        fromBusiness: boolean,
        answerText: string | null
    ) {
        try {
            await db.insert(comments).values({
                commentId,
                mediaId,
                senderId,
                senderUsername: senderUsername ?? null,
                text: text ?? null,
                parentId,
                fromBusiness,
                isQuestion: !fromBusiness && this.isQuestionText(text ?? ''),
                answerText
            })
        } catch (err) {
            log.error({ module: 'webhook', commentId, error: String(err) }, '[webhook] failed to store comment')
        }
    }

    private async handleCommentWithReply(
        commentId: string,
        mediaId: string,
        senderId: string,
        senderUsername: string | null | undefined,
        text: string
    ) {
        log.info({ module: 'webhook', commentId, mediaId, senderId }, '[webhook] processing comment with reply')

        await ensurePatient(senderId)

        let answer: string
        let intent = 'query'

        try {
            const result = await runPipeline(text)
            answer = result.answer
            intent = result.intent
        } catch (err) {
            log.error({ module: 'webhook', error: String(err) }, '[webhook] pipeline error for comment')
            answer = env.WEBHOOK_AUTO_REPLY_TEXT
        }

        const replyResult = await this.instagramCommentService.replyToComment(commentId, answer)

        if (replyResult.status === 'error') {
            log.error(
                { module: 'webhook', commentId, error: replyResult.message },
                '[webhook] comment reply failed'
            )
        } else {
            log.info(
                { module: 'webhook', commentId, intent, answerLength: answer.length },
                '[webhook] comment reply sent'
            )
        }

        await this.storeComment(commentId, mediaId, senderId, senderUsername, text, null, false, answer)

        await this.storeComment(
            commentId + '_reply',
            mediaId,
            senderId,
            senderUsername,
            answer,
            commentId,
            true,
            null
        )
    }

    private async handleIncomingMessage(
        senderId: string,
        text: string | null,
        messageMetadata?: Record<string, unknown>,
        mid?: string
    ) {
        log.info(
            { module: 'webhook', senderId, hasText: !!text, textLength: text?.length ?? 0, mid },
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

        // Message Deduplication and Persistence
        if (env.INSTAGRAM_BUSINESS_ID && text) {
            if (mid) {
                const inserted = await db
                    .insert(messages)
                    .values({
                        conversationId: conv.id,
                        fromId: senderId,
                        text,
                        metadata: messageMetadata,
                        mid
                    })
                    .onConflictDoNothing()
                    .returning({ id: messages.id })

                if (inserted.length === 0) {
                    log.info({ module: 'webhook', mid }, '[webhook] duplicate message detected, skipping')
                    return
                }
                log.info(
                    { module: 'webhook', conversationId: conv.id.toString(), mid },
                    '[webhook] message stored'
                )
            } else {
                // Fallback for messages without mid
                db.insert(messages)
                    .values({
                        conversationId: conv.id,
                        fromId: senderId,
                        text,
                        metadata: messageMetadata
                    })
                    .then(() => {
                        log.info(
                            { module: 'webhook', conversationId: conv.id.toString() },
                            '[webhook] message stored'
                        )
                    })
                    .catch((err) => {
                        log.error({ module: 'webhook', error: String(err) }, '[webhook] message insert failed')
                    })
            }
        }

        // Fire-and-forget Instagram user info enrichment (non-blocking)
        if (isNewConversation) {
            tokenService
                .getDecryptedToken(env.INSTAGRAM_BUSINESS_ID!)
                .then((token) => {
                    if (!token) return
                    return fetchInstagramUserInfo(senderId, token)
                })
                .then((igInfo) => {
                    if (!igInfo) return
                    const updates: Parameters<typeof updatePatient>[1] = {
                        instagramName: igInfo.name,
                        instagramUsername: igInfo.username
                    }
                    if (!patient.name && !patient.nameSource) {
                        updates.nameSource = 'instagram'
                    }
                    return updatePatient(senderId, updates)
                })
                .catch((err) => {
                    log.warn({ module: 'webhook', error: String(err) }, '[webhook] instagram info fetch failed')
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
                db.insert(messages)
                    .values({
                        conversationId: conv.id,
                        fromId: env.INSTAGRAM_BUSINESS_ID,
                        text: answer
                    })
                    .catch((err) => {
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
