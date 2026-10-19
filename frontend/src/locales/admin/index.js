// Admin dictionaries are independent of the synced workout language.
import { messages } from './messages.js'
import { coachMessages } from './coach-messages.js'
import { auditMessages } from './audit-messages.js'
import { workflowMessages } from './workflow-messages.js'
import { redesignMessages } from './redesign-messages.js'
export const languages = { en: 'English', 'uz-Latn': 'O‘zbekcha', 'uz-Cyrl': 'Ўзбекча', ru: 'Русский' }
export const dictionaries = {
  en: {},
  ru: { Overview: 'Обзор', Users: 'Пользователи', Invites: 'Приглашения', 'AI Coach': 'ИИ-тренер', Activity: 'Активность', 'Back to workouts': 'К тренировкам', 'Admin workspace': 'Панель администратора', 'Admin language': 'Язык панели', 'Search users': 'Поиск пользователей', 'Account status': 'Статус учётной записи', 'All accounts': 'Все учётные записи', Enabled: 'Включены', Disabled: 'Отключены', 'No matching users': 'Совпадений нет', 'Copy admin link': 'Копировать ссылку', 'Copied': 'Скопировано', 'Copy failed. Select and copy the text.': 'Не удалось скопировать. Выделите и скопируйте текст.', 'Administrator access required': 'Требуется доступ администратора', Home: 'Главная', 'Switch account': 'Сменить учётную запись', 'Sign in': 'Войти' },
  'uz-Latn': { Overview: 'Umumiy ko‘rinish', Users: 'Foydalanuvchilar', Invites: 'Takliflar', 'AI Coach': 'AI murabbiy', Activity: 'Faollik', 'Back to workouts': 'Mashqlarga qaytish', 'Admin workspace': 'Administrator paneli', 'Admin language': 'Panel tili', 'Search users': 'Foydalanuvchilarni qidirish', 'Account status': 'Hisob holati', 'All accounts': 'Barcha hisoblar', Enabled: 'Faol', Disabled: 'O‘chirilgan', 'No matching users': 'Mos foydalanuvchilar yo‘q', 'Copy admin link': 'Panel havolasini nusxalash', Copied: 'Nusxalandi', 'Copy failed. Select and copy the text.': 'Nusxalanmadi. Matnni tanlab nusxalang.', 'Administrator access required': 'Administrator ruxsati kerak', Home: 'Bosh sahifa', 'Switch account': 'Hisobni almashtirish', 'Sign in': 'Kirish' },
  'uz-Cyrl': { Overview: 'Умумий кўриниш', Users: 'Фойдаланувчилар', Invites: 'Таклифлар', 'AI Coach': 'AI мураббий', Activity: 'Фаоллик', 'Back to workouts': 'Машқларга қайтиш', 'Admin workspace': 'Администратор панели', 'Admin language': 'Панель тили', 'Search users': 'Фойдаланувчиларни қидириш', 'Account status': 'Ҳисоб ҳолати', 'All accounts': 'Барча ҳисоблар', Enabled: 'Фаол', Disabled: 'Ўчирилган', 'No matching users': 'Мос фойдаланувчилар йўқ', 'Copy admin link': 'Панель ҳаволасини нусхалаш', Copied: 'Нусхаланди', 'Copy failed. Select and copy the text.': 'Нусхаланмади. Матнни танлаб нусхаланг.', 'Administrator access required': 'Администратор рухсати керак', Home: 'Бош саҳифа', 'Switch account': 'Ҳисобни алмаштириш', 'Sign in': 'Кириш' },
}
for (const key of Object.keys(dictionaries.ru)) dictionaries.en[key] = key
for (const [key, ru, latin, cyrillic] of [...messages, ...coachMessages, ...auditMessages, ...workflowMessages, ...redesignMessages]) {
  dictionaries.en[key] = key
  dictionaries.ru[key] = ru
  dictionaries['uz-Latn'][key] = latin
  dictionaries['uz-Cyrl'][key] = cyrillic
}
// Protocol names, commands and identifiers must remain unchanged in every language.
for (const key of ['COACH_DISABLED', 'Ollama', 'LM Studio', 'vLLM', 'OpenRouter', '/v1', '/v4', 'Name: value', 'Authorization', 'Content-Type', './data', 'secret', 'claude setup-token']) {
  for (const dictionary of Object.values(dictionaries)) dictionary[key] = key
}
