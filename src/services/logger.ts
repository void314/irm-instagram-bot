import { createPinoLogger } from '@bogeychan/elysia-logger'

import pino from 'pino'

import { env } from '../config/constants'

const isDEV = env.NODE_ENV === 'development'
const level = isDEV ? 'debug' : 'info'

// Настраиваем мультипоточный транспорт
const transport = pino.transport({
    targets: [
        // 1. Поток записи в файл (всегда активен)
        {
            target: 'pino/file',
            level: level,
            options: {
                destination: './logs/app.log',
                mkdir: true
            } as any
        },
        // 2. Поток вывода в консоль
        {
            // В dev-режиме делаем логи красивыми, в prod — выводим стандартный JSON
            target: level === 'debug' ? 'pino-pretty' : 'pino/file',
            level: level,
            options: (isDEV
                ? {
                      colorize: true,
                      translateTime: 'SYS:dd.mm.yyyy HH:MM:ss',
                      ignore: 'pid,hostname',
                      singleLine: true
                  }
                : { destination: 1 }) as any
        }
    ]
})

export const log = createPinoLogger({
    level,
    // Передаем сгенерированный мультипоток в качестве основного stream
    stream: transport
})

export const loggerPlugin = log.into({ autoLogging: true })
