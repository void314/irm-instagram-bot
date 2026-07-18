import Elysia, { status } from 'elysia'

import * as models from './model'
import { InstagramService } from './service'

const instagramService = new InstagramService()

export const instagramController = new Elysia({
    name: 'module.instagram',
    prefix: '/instagram',
    detail: { tags: ['Instagram'] }
})
    .model(models)
    .get(
        '/me',
        async () => {
            return await instagramService.getProfile()
        },
        {
            response: {
                200: 'instagramProfileResponse200',
                400: 'instagramProfileResponse400'
            },
            detail: {
                summary: 'Instagram profile check',
                description: 'Verify access to Instagram Business Account via Graph API'
            }
        }
    )
