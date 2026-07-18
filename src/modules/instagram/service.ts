import { env } from '../../config/constants'
import { TokenService } from '../tokens'
import type { InstagramProfileResponse200, InstagramProfileResponse400 } from './model'

type InstagramProfile = {
    id: string
    username: string
}

const tokenService = new TokenService()

export class InstagramService {
    public async getProfile(): Promise<InstagramProfileResponse200 | InstagramProfileResponse400> {
        if (!env.INSTAGRAM_BUSINESS_ID) {
            return { status: 'error', message: 'Missing INSTAGRAM_BUSINESS_ID' }
        }

        const pageToken = await tokenService.getDecryptedToken(env.INSTAGRAM_BUSINESS_ID)

        if (!pageToken) {
            return { status: 'error', message: 'No page access token available' }
        }

        const url = new URL(
            `https://graph.facebook.com/${env.FACEBOOK_GRAPH_API_VERSION}/${env.INSTAGRAM_BUSINESS_ID}`
        )
        url.searchParams.set('fields', 'id,username')
        url.searchParams.set('access_token', pageToken)

        const response = await fetch(url)
        const data = (await response.json()) as { error?: { message?: string } } & InstagramProfile

        if (!response.ok) {
            return {
                status: 'error',
                message: data?.error?.message || 'Instagram API request failed'
            }
        }

        return {
            status: 'ok',
            data: {
                id: data.id,
                username: data.username
            }
        }
    }
}
