import Elysia from 'elysia'

import { log } from '../../services/logger'
import { TokenService } from './service'

const tokenService = new TokenService()
const CRON_INTERVAL = 12 * 60 * 60 * 1000

export const tokenCronController = new Elysia({
    name: 'module.tokens.cron'
}).onStart(async () => {
    const run = async () => {
        try {
            const result = await tokenService.refreshAllActive()
            if (result.refreshed > 0 || result.failed > 0) {
                log.info(
                    { errors: result.errors.length > 0 ? result.errors : undefined },
                    `[TokenCron] refreshed=${result.refreshed} failed=${result.failed}`
                )
            }
        } catch (err) {
            log.error({ err }, '[TokenCron] error')
        }
    }

    await run()
    setInterval(run, CRON_INTERVAL)
    log.info(`[TokenCron] started — every ${CRON_INTERVAL / 60000}min`)
})
