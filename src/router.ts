import Elysia from 'elysia'

import { healthController } from './modules/health'

const router = new Elysia({
    prefix: '/api'
}).use(healthController)

export default router
