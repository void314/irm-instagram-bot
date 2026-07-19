import { franc } from 'franc-min'

export function detectLanguage(text: string): 'ru' | 'kk' | 'en' {
    const trimmed = text.trim()
    if (!trimmed) return 'ru'

    const detected = franc(trimmed, { minLength: 3 })

    if (detected === 'kaz') return 'kk'
    if (detected === 'rus') return 'ru'

    // franc-min returns 'eng' for English. If it's undefined ('und') or anything else, default to en
    return 'en'
}
