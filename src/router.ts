import Elysia from 'elysia'

import { healthController } from './modules/health'
import { instagramController } from './modules/instagram'

const router = new Elysia({
    prefix: '/api'
})
    .use(healthController)
    .use(instagramController)

export default router
