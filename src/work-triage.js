// Conservative, AI-free first pass for work content. An allowlisted chat
// establishes its source, not that every private message is work-related.
// Uncertain private messages must not be stored or sent to external AI.
const brief=s=>String(s||'').replace(/\s+/g,' ').trim().slice(0,5000);
const workTerms=/(?:\b(?:ott|epg|kpi|uefa|fide|hbo|sport|live|email|outlook|gmail|design|deadline|banner|stream|content|release|draft|meeting|report|broadcast|schedule|promo)\b|работ[аыеуы]|коллег|задач|письм|почт|баннер|эфир|трансляц|турнир|футбол|матч|контент|платформ|дизайн|макет|логотип|материал|встреч|совещан|дедлайн|отч[её]т|таблиц|расписан|презентац|релиз|промокод|согласован|правообладател|подписк|отдел|редакци|канал|серия|выпуск|провер[кьи]|исправлен|изменен|изменён|срок)/iu;
const explicitTask=/(?:^|[\s,.:;!?])(?:подготовь|сделай|создай|проверь|пришли|отправь|добавь|обнови|исправь|замени|поменяй|отметь|согласуй|закажи|запланируй|посмотри|найди|нужно\s+(?:сделать|подготовить|обновить|отправить|проверить|согласовать)|прошу\s+(?:сделать|подготовить|прислать|отправить|согласовать)|можешь(?:\s+пожалуйста)?\s+(?:меня\s+)?(?:подготовить|заменить|отправить|проверить|обновить|согласовать)|өтінем|дайында|жібер|жаса|тексер|please\s+(?:send|prepare|check|update|make|review)|could\s+you\s+(?:send|prepare|check|update))(?=$|[\s,.:;!?])/iu;
const informational=/(?:\b(?:newsletter|digest|fyi|update|press\s+release|announcement)\b|дайджест|новост|рассылк|пресс[- ]релиз|уведомлен|итог|информац|анонс|объявлен|публикац|обзор)/iu;
const urgent=/(?:срочно|немедленно|asap|urgent|шұғыл|бүгін|сегодня|до\s+конца\s+дня)/iu;
const notUrgent=/(?:не\s+срочно|когда\s+будет\s+время|no\s+rush)/iu;
const quoted=/^\s*(?:>|от:|from:|пересланное сообщение|forwarded message)/iu;
export function triageTelegram(text,{privateChat=false,workOnly=false}={}){
  const value=brief(text);
  const work=workTerms.test(value);
  const task=explicitTask.test(value)&&!quoted.test(value);
  // Chats are opt-in allowlisted. In work mode, do not retain ambiguous
  // private chat content merely because the contact has been selected.
  if(privateChat&&workOnly&&!work)return {category:'SKIP',reason:'no_work_signal'};
  const priority=notUrgent.test(value)?'низкий':urgent.test(value)?'высокий':'средний';
  if(task)return {category:'TASK',priority,summary:value.slice(0,280)};
  if(privateChat||!work&&!informational.test(value))
    return {category:'REVIEW',priority,summary:value.slice(0,280)};
  return {category:'NEWS',priority,summary:value.slice(0,280)};
}
export function triageWorkMailSubject(subject){
  const title=brief(subject).slice(0,350);
  // No corporate body is sent to Groq or interpreted as instructions here.
  // A clear newsletter subject can be filed as news without inventing tasks.
  if(informational.test(title)&&!explicitTask.test(title))return {
    category:'НОВОСТЬ',priority:'низкий',summary:title,
    action:'Действий не требуется',deadline_text:'Не указан',
    deadline_iso:'',needs_review:false
  };
  return {
    category:'ПИСЬМО',priority:urgent.test(title)?'высокий':'средний',
    summary:title,action:'Просмотреть рабочее письмо',
    deadline_text:'Не указан',deadline_iso:'',needs_review:true
  };
}
