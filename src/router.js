// Pure parsing/formatting so we can test without Google, Telegram, or Groq.
export function commandOf(update) {
  const callback = update?.callback_query?.data;
  if (typeof callback === 'string') return callback;
  const raw = String(update?.message?.text ?? '').trim();
  const lower = raw.toLowerCase().replace(/^\/(\w+)@[a-z0-9_]+$/i, '/$1');
  const exact = {
    '/start': 'menu', '/menu': 'menu', 'меню': 'menu',
    '/cancel': 'cancel', 'отмена': 'cancel', '/reset': 'reset',
    '/today': 'today', '/week': 'week', '/important': 'important',
    '/news': 'news', '/colleagues': 'colleagues', '/search': 'search'
  };
  if (exact[lower]) return exact[lower];
  if (lower.includes('что важного')) return 'important';
  if (lower.includes('что у меня сегодня') || lower === 'задачи на сегодня') return 'today';
  if (lower.includes('на неделю')) return 'week';
  if (lower.includes('новост')) return 'news';
  if (lower.includes('коллег') && lower.includes('письм')) return 'colleagues';
  return '';
}
export function getChatId(update) {
  const chat = update?.callback_query?.message?.chat ?? update?.message?.chat;
  return chat?.id == null ? null : String(chat.id);
}
export const QUICK_ACTIONS = new Set(['menu', 'cancel', 'reset', 'reset:no']);
export function hasValidSecret(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string' || !expected.length || received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= received.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
export function safeText(value, max = 3900) {
  const text = String(value ?? '');
  return text.length <= max ? text : text.slice(0, max - 25) + '\n\n[Текст сокращён]';
}
export function menuMarkup() {
  return {inline_keyboard: [
    [{text:'🔥 Важное',callback_data:'important'},{text:'✅ Сегодня',callback_data:'today'}],
    [{text:'📅 Неделя',callback_data:'week'},{text:'👥 Коллеги',callback_data:'colleagues'}],
    [{text:'📰 Новости',callback_data:'news'},{text:'🔎 Поиск',callback_data:'search'}],
    [{text:'🧠 Сброс контекста',callback_data:'reset'}]
  ]};
}
export function backMarkup() { return {inline_keyboard:[[{text:'☰ Меню',callback_data:'menu'}]]}; }
export function emailMarkup(emailId) { return {inline_keyboard:[
  [{text:'✅ В задачи',callback_data:'email:task:'+emailId}],
  [{text:'☰ Меню',callback_data:'menu'}]
]}; }
export function taskMarkup(taskId) { return {inline_keyboard:[
  [{text:'🟡 В работу',callback_data:'task:progress:'+taskId},{text:'✅ Выполнено',callback_data:'task:done:'+taskId}],
  [{text:'☰ Меню',callback_data:'menu'}]
]}; }
export function normalizePriority(value) { return ['высокий','средний','низкий'].includes(value) ? value : 'средний'; }
export function isEmailObject(x) { return x && typeof x === 'object' && typeof x.email_id === 'string' && /^[A-Za-z0-9_-]{5,48}$/.test(x.email_id) && typeof x.subject === 'string'; }
export function localDayBounds(now, offsetMinutes = 300) {
  const offset = Number.isFinite(Number(offsetMinutes)) ? Number(offsetMinutes) : 300;
  const time = now.getTime() + offset * 60000;
  const start = Math.floor(time / 86400000) * 86400000 - offset * 60000;
  return {start: new Date(start), end: new Date(start + 86400000)};
}
