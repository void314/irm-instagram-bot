import { createPinoLogger } from '@bogeychan/elysia-logger'

import pino from 'pino'

import { env } from '../config/constants'

const level = env.NODE_ENV === 'development' ? 'info' : 'error'

export const log = createPinoLogger({
    level,
    stream: pino.destination({ sync: true }),
    file: 'log.log'
})

export const loggerPlugin = log.into({ autoLogging: true })

