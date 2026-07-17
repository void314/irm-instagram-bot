import Elysia from 'elysia'
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
                console.log(
                    `[TokenCron] refreshed=${result.refreshed} failed=${result.failed}`,
                    result.errors.length > 0 ? `errors=${result.errors.join(', ')}` : ''
                )
            }
        } catch (err) {
            console.error('[TokenCron] error:', err)
        }
    }

    await run()
    setInterval(run, CRON_INTERVAL)
    console.log(`[TokenCron] started — every ${CRON_INTERVAL / 60000}min`)
})
