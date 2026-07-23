import { franc } from 'franc-min'

const MIN_LENGTH_FOR_DETECTION = 15

export function detectLanguage(text: string): 'ru' | 'kk' | 'en' | null {
    const trimmed = text.trim()
    if (!trimmed || trimmed.length < MIN_LENGTH_FOR_DETECTION) return null

    const detected = franc(trimmed, { minLength: 3, only: ['rus', 'kaz', 'eng'] })

    if (detected === 'kaz') return 'kk'
    if (detected === 'rus') return 'ru'
    if (detected === 'eng') return 'en'

    return null
}
