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
    '/news': 'news', '/colleagues': 'colleagues', '/search': 'search',
    '/tasks': 'tasks', '/progress': 'progress', '/done': 'done', '/report': 'report', '/summary': 'report', '/new': 'newtask', '/mail': 'mail',
    '/calendar': 'calendar', '/compose': 'compose', '/contacts': 'contacts',
    '/review': 'review',
    '/memory': 'memory', '/brief': 'brief', '/app': 'app'
  };
  if (exact[lower]) return exact[lower];
  if (lower.includes('что важного')) return 'important';
  if (lower.includes('что у меня сегодня') || lower === 'задачи на сегодня') return 'today';
  if (lower.includes('на неделю')) return 'week';
  if (lower.includes('новост')) return 'news';
  if (lower.includes('коллег') && lower.includes('письм')) return 'colleagues';
  if (lower === 'задачи в работе' || lower === 'задачи (в работе)' || lower === 'в работе') return 'progress';
  if (lower === 'выполненные' || lower === 'выполненные задачи') return 'done';
  if (lower === 'список задач' || lower === 'покажи задачи' || lower === 'мои задачи' ||
      lower === 'задачи не в работе' || lower === 'задачи (не в работе)') return 'tasks';
  if (lower === 'отчёт по задачам' || lower === 'отчет по задачам' || lower === 'сводка') return 'report';
  if (lower === 'проверь почту' || lower === 'проверить почту') return 'mail:refresh';
  if (lower === 'на разбор' || lower === 'проверь неопределённые' ||
      lower === 'покажи непонятные сообщения') return 'review';
  return '';
}
export function getChatId(update) {
  const chat = update?.callback_query?.message?.chat ?? update?.message?.chat;
  return chat?.id == null ? null : String(chat.id);
}
// Callback identifiers of the legacy Apps Script bot. Its old messages stay in
// the chat after cutover, so their buttons are mapped to the current actions.
const LEGACY_EXACT={
  open_menu:'menu',menu_important:'important',menu_today:'today',menu_week:'week',
  menu_news:'news',menu_colleagues:'colleagues',menu_search:'search',
  menu_mail:'mail:refresh',menu_reset:'reset',confirm_reset:'reset:yes',cancel_reset:'reset:no'
};
const LEGACY_PREFIX={
  'task_done:':'task:done:','task_progress:':'task:progress:','task_view:':'task:view:',
  'email_view:':'email:view:','email_task:':'email:task:','email_reply:':'email:reply:'
};
// Draft buttons share their names with the current version and are left alone;
// an unknown legacy draft ID is simply reported as not found.
const LEGACY_STALE=/^(?:attget:|email_atts:|refreshdraft:)/;
export function upgradeLegacyCallback(data) {
  const value=String(data??'');
  if(Object.hasOwn(LEGACY_EXACT,value))return LEGACY_EXACT[value];
  for(const [old,current] of Object.entries(LEGACY_PREFIX))
    if(value.startsWith(old))return current+value.slice(old.length);
  return LEGACY_STALE.test(value)?'legacy:stale':value;
}
export const QUICK_ACTIONS = new Set([
  'legacy:stale','menu','cancel','reset','reset:no','reset:yes','more','tasks','progress','done',
  'report','review','important','colleagues','week','news','mail','newtask','search','voicehelp'
]);
export function isQuickAction(action) {
  const value=String(action||'');
  return QUICK_ACTIONS.has(value)||
    /^(?:task:|mention:view:|mention:(?:task|news|ignore):|email:view:|email:(?:task|news|ignore):)/.test(value);
}
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
// Telegram chooses button widths. Two short, balanced labels per row
// prevent the tall, irregular single-column menu seen in the old bot.
export function menuMarkup(miniAppUrl='') {
  const panel=/^https:\/\/[a-z0-9.-]+\/app$/i.test(String(miniAppUrl||''))
    ? {text:'📱 Панель',web_app:{url:miniAppUrl}}
    : {text:'🎙 Голосом',callback_data:'voicehelp'};
  return {inline_keyboard: [
    [{text:'📥 Задачи (не в работе)',callback_data:'tasks'}],
    [{text:'🟡 Задачи (в работе)',callback_data:'progress'}],
    [{text:'✅ Выполненные',callback_data:'done'},{text:'📰 Новости (интересное)',callback_data:'news'}],
    [{text:'📊 Сводка',callback_data:'report'},{text:'➕ Новая задача',callback_data:'newtask'}],
    [{text:'📨 Почта',callback_data:'mail'},{text:'🔎 Поиск',callback_data:'search'}],
    [{text:'🗓 Календарь',callback_data:'calendar'},{text:'✉️ Написать',callback_data:'compose'}],
    [panel,{text:'☰ Ещё',callback_data:'more'}]
  ]};
}
export function moreMarkup(){return {inline_keyboard:[
  [{text:'🔥 Важное',callback_data:'important'},{text:'⚠️ На разбор',callback_data:'review'}],
  [{text:'👥 Коллеги',callback_data:'colleagues'},{text:'📅 Неделя',callback_data:'week'}],
  [{text:'🧠 Память',callback_data:'memory'},{text:'🔄 Проверить почту',callback_data:'mail:refresh'}],
  [{text:'👥 Контакты',callback_data:'contacts'},{text:'🧹 Очистить чат',callback_data:'reset'}],
  [{text:'☰ Главное',callback_data:'menu'}]
]};}
export function backMarkup() { return {inline_keyboard:[[{text:'☰ Меню',callback_data:'menu'}]]}; }
export function emailMarkup(emailId) { return {inline_keyboard:[
  [{text:'✅ В задачи',callback_data:'email:task:'+emailId},
   {text:'✉️ Черновик',callback_data:'email:reply:'+emailId}],
  [{text:'☰ Меню',callback_data:'menu'}]
]}; }
export function taskMarkup(taskId,status='NEW') { return {inline_keyboard:[
  ...(status==='NEW' ? [[{text:'🟡 Взять в работу',callback_data:'task:progress:'+taskId}]] : []),
  ...(status==='IN_PROGRESS' ? [
    [{text:'🎯 Приоритет',callback_data:'task:priority-menu:'+taskId},
     {text:'📅 Дедлайн',callback_data:'task:postpone:'+taskId}],
    [{text:'✏️ Описание',callback_data:'task:edit:'+taskId},
     {text:'💬 Комментарий',callback_data:'task:comment:'+taskId}],
    [{text:'📎 Исходник',callback_data:'task:source:'+taskId},
     {text:'✅ Выполнено',callback_data:'task:done:'+taskId}]
  ] : []),
  ...(status==='DONE' ? [[
    {text:'↩️ Вернуть в работу',callback_data:'task:restore:'+taskId},
    {text:'📎 Исходник',callback_data:'task:source:'+taskId}
  ]] : []),
  [{text:'🗑 Удалить',callback_data:'task:delete:ask:'+taskId},{text:'☰ Меню',callback_data:'menu'}]
]}; }
export function normalizePriority(value) { return ['высокий','средний','низкий'].includes(value) ? value : 'средний'; }
export function isEmailObject(x) { return x && typeof x === 'object' && typeof x.email_id === 'string' && /^[A-Za-z0-9_-]{5,48}$/.test(x.email_id) && typeof x.subject === 'string'; }
export function localDayBounds(now, offsetMinutes = 300) {
  const offset = Number.isFinite(Number(offsetMinutes)) ? Number(offsetMinutes) : 300;
  const time = now.getTime() + offset * 60000;
  const start = Math.floor(time / 86400000) * 86400000 - offset * 60000;
  return {start: new Date(start), end: new Date(start + 86400000)};
}
