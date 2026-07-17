const KAZAKH_CHARS = /[ңғқәіұүөһҢҒҚӘІҰҮӨҺ]/
const CYRILLIC = /[а-яёА-ЯЁ]/
const LATIN = /[a-zA-Z]/

export function detectLanguage(text: string): 'ru' | 'kk' | 'en' {
    const trimmed = text.trim()
    if (!trimmed) return 'ru'

    if (KAZAKH_CHARS.test(trimmed)) return 'kk'

    const cyrillicCount = (trimmed.match(CYRILLIC) || []).length
    const latinCount = (trimmed.match(LATIN) || []).length

    if (cyrillicCount > latinCount) return 'ru'
    if (latinCount > cyrillicCount) return 'en'

    return 'ru'
}
