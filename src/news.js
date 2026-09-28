import {backMarkup,safeText} from './router.js';

const unescapeXml=x=>String(x||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
  .replace(/<[^>]*>/g,'').replace(/&amp;/g,'&')
  .replace(/&quot;/g,'"').replace(/&apos;/g,"'")
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
  .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
function value(xml,tag){
  const match=xml.match(new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+tag+'>','i'));
  return unescapeXml(match?.[1]||'').trim();
}
export async function newsFeed(query='Казахстан',limit=8){
  const term=String(query||'Казахстан').replace(/[\r\n]/g,' ').trim().slice(0,90);
  const url=new URL('https://news.google.com/rss/search');
  url.searchParams.set('q',term||'Казахстан');
  url.searchParams.set('hl','ru');
  url.searchParams.set('gl','KZ');
  url.searchParams.set('ceid','KZ:ru');
  try{
    const response=await fetch(url.toString(),{
      method:'GET',headers:{accept:'application/rss+xml, application/xml, text/xml'},
      signal:AbortSignal.timeout(10000)
    });
    if(!response.ok)throw Error('News RSS unavailable');
    const raw=await response.text();
    if(raw.length>2000000)throw Error('News RSS too large');
    const items=[...raw.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)]
      .slice(0,Math.min(12,Math.max(1,limit))).map(([,data])=>({
        title:value(data,'title').slice(0,230),
        link:value(data,'link').slice(0,900),
        date:value(data,'pubDate').slice(0,85)
      })).filter(x=>x.title);
    if(!items.length)throw Error('News RSS empty');
    return {ok:true,query:term,items};
  }catch(err){
    console.error(JSON.stringify({event:'news_feed_unavailable',error_type:err?.name||'Error'}));
    return {ok:false,query:term,items:[]};
  }
}
export async function latestNews(query='Казахстан'){
  const feed=await newsFeed(query,7);
  if(!feed.ok)return {text:'Пока не удалось загрузить свежие новости. Попробуй позже. Не буду придумывать заголовки.',
    reply_markup:backMarkup()};
  const lines=feed.items.map((item,i)=>{
    let link='';
    try{
      const url=new URL(item.link);
      if(url.protocol==='https:'&&url.hostname==='news.google.com')
        link='\n'+url.href;
    }catch{/* Do not echo non-HTTPS or arbitrary RSS URLs. */}
    return (i+1)+'. '+item.title+link;
  });
  return {text:safeText('📰 Новости по запросу «'+feed.query+'»\n\n'+lines.join('\n\n')+
    '\n\nИсточник: Google News RSS. Заголовки не равнозначны проверенным фактам.'),
    reply_markup:backMarkup()};
}
