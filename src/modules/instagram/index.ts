import Elysia from 'elysia'

import { instagramProfileResponse200, instagramProfileResponse400 } from './model'
import { InstagramService } from './service'

const instagramService = new InstagramService()

export const instagramController = new Elysia({ prefix: '/instagram', detail: { tags: ['Instagram'] } }).get(
    '/me',
    async ({ set }) => {
        const result = await instagramService.getProfile()

        if (result.status === 'error') {
            set.status = 400
            return result
        }

        return result
    },
    {
        response: {
            200: instagramProfileResponse200,
            400: instagramProfileResponse400
        },
        detail: {
            summary: 'Instagram profile check',
            description: 'Verify access to Instagram Business Account via Graph API'
        }
    }
)
