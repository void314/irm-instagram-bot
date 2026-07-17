import { env } from '../../../config/constants'

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
