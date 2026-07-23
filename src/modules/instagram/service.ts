import { status } from 'elysia'

import { env } from '../../config/constants'
import { TokenService } from '../tokens'
import type { InstagramProfileResponse200, InstagramProfileResponse400 } from './model'

type InstagramProfile = {
    id: string
    username: string
}

const tokenService = new TokenService()

export class InstagramService {
    public async getProfile() {
        if (!env.INSTAGRAM_BUSINESS_ID) {
            return status(400, {
                status: 'error',
                message: 'Missing INSTAGRAM_BUSINESS_ID'
            } as InstagramProfileResponse400)
        }

        const pageToken = await tokenService.getDecryptedToken(env.INSTAGRAM_BUSINESS_ID)

        if (!pageToken) {
            return status(400, {
                status: 'error',
                message: 'No page access token available'
            } as InstagramProfileResponse400)
        }

        const url = new URL(`https://graph.facebook.com/${env.FACEBOOK_GRAPH_API_VERSION}/${env.INSTAGRAM_BUSINESS_ID}`)
        url.searchParams.set('fields', 'id,username')
        url.searchParams.set('access_token', pageToken)

        const response = await fetch(url)
        const data = (await response.json()) as { error?: { message?: string } } & InstagramProfile

        if (!response.ok) {
            return status(400, {
                status: 'error',
                message: data?.error?.message || 'Instagram API request failed'
            } as InstagramProfileResponse400)
        }

        return {
            status: 'ok',
            data: {
                id: data.id,
                username: data.username
            }
        } as InstagramProfileResponse200
    }
}
