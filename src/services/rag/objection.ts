import { chat } from '../llm/openrouter'

const CLASSIFICATION_PROMPT = `Ты — классификатор сообщений в клинику ЭКО.
Определи, является ли сообщение пользователя возражением или обычным вопросом.

Возражение — это сомнение, отговорка, несогласие:
- дорого, дороговато, слишком дорого
- перезвоню позже, позже перезвоню
- сравниваю с другими клиниками, в других клиниках дешевле
- нужно подумать, посоветуюсь с семьёй/мужем/женой
- просто узнать цену, только цена, чисто узнать

Обычный вопрос — всё остальное: о ценах, услугах, врачах, расписании, программах ЭКО, обследованиях.

Ответь ТОЛЬКО одним словом: objection или not_objection`

export async function detectObjection(query: string): Promise<boolean> {
    const { content } = await chat(
        [{ role: 'user', content: `${CLASSIFICATION_PROMPT}\n\nСообщение: ${query}` }],
        { max_tokens: 10, temperature: 0 }
    )
    return content.trim().toLowerCase() === 'objection'
}
