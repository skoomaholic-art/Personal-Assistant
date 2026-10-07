// Central work-only policy. The owner can later opt into personal features,
// but merely retaining earlier OAuth credentials never enables personal access.
export const workOnly=env=>env.ASSISTANT_SCOPE==='work';
export const WORK_EMAIL_STATUSES="('NEW','WORK_REVIEW','WORK_OUTLOOK')";
export const workOnlyReply=()=>({
  text:'Сейчас я настроен только на рабочие дела. Личную почту, календарь и личные поручения пока не обрабатываю.',
  reply_markup:{inline_keyboard:[[{text:'☰ Меню',callback_data:'menu'}]]}
});
