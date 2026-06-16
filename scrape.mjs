// 55型有機ELテレビ 価格&セール情報ウォッチャー
// 価格: Amazon(発見) + 価格.com(量販店最安) + 楽天 + Qoo10
// ニュース: Google News RSS で「テレビ セール/値下げ/プライムデー」等を監視
// docs/data.json: { updatedAt, products:{model:{...,history:[{t,a,k,r,q}]}}, news:[...] }
// 総合最安が前回より下落 or 新着セール記事 → ntfy.sh/ccr 通知
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(ROOT, 'docs', 'data.json');
const NTFY_TOPIC = 'https://ntfy.sh/ccr';
const PAGE_URL = 'https://watsuyo.github.io/tv-price-watcher/'; // 比較表(通知で常に案内)
const SANITY_MIN = 70000, SANITY_MAX = 250000; // 55型OLEDの妥当価格帯(ケーブル等を除外)

const SEARCH_URL =
  'https://www.amazon.co.jp/s?k=4K+%E6%9C%89%E6%A9%9Fel+%E3%83%86%E3%83%AC%E3%83%93' +
  '&rh=p_n_feature_three_browse-bin%3A213301351051' +
  '%2Cp_n_feature_two_browse-bin%3A4910340051' +
  '%2Cp_n_g-1003296671111%3A10518582051' +
  '%2Cp_36%3A8500000-18000000&dc&reform=4k&rnid=401022011';

const MODEL_PATTERNS = [
  /OLED\d{2}[A-Z]\d[A-Z]{3}/i, /4T-C\d{2}[A-Z]{2}\d/i, /\b\d{2}X\d{4}[A-Z]\b/i,
  /TH-\d{2}[A-Z]{2}\d{4}/i, /XRJ-\d{2}[A-Z]\d{2}[A-Z]?/i, /K-\d{2}X[A-Z]\d{2}[A-Z]?/i,
  /\b\d{2}U[A-Z]?\d[A-Z]+\b/i,
];
const extractModel = t => { for (const re of MODEL_PATTERNS) { const m = t.match(re); if (m) return m[0].toUpperCase(); } return null; };
const detectBrand = t => {
  for (const [b, re] of [['LG', /\bLG\b/i], ['シャープ', /シャープ|AQUOS/], ['REGZA', /REGZA|レグザ/],
    ['パナソニック', /パナソニック|VIERA/], ['ソニー', /ソニー|BRAVIA/i], ['ハイセンス', /ハイセンス|Hisense/i]]) if (re.test(t)) return b;
  return 'その他';
};
const sane = p => (p !== null && p >= SANITY_MIN && p <= SANITY_MAX) ? p : null;
const norm = s => s.toUpperCase().replace(/[\s\-－ー]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const yen = n => parseInt(String(n).replace(/[^0-9]/g, ''), 10);

// ---------- Amazon: 追跡対象の発見 + 価格 ----------
async function scrapeAmazon(page) {
  const out = new Map();
  for (let n = 1; n <= 2; n++) {
    await page.goto(n === 1 ? SEARCH_URL : `${SEARCH_URL}&page=${n}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);
    const items = await page.$$eval('div[data-component-type="s-search-result"]', els => els.map(el => ({
      title: el.querySelector('h2')?.textContent.trim() ?? '',
      priceText: el.querySelector('.a-price .a-offscreen')?.textContent.trim() ?? '',
      link: el.querySelector('h2 a, a.a-link-normal')?.getAttribute('href') ?? '',
      sponsored: !!el.querySelector('.puis-sponsored-label-text'),
    }))).catch(() => []);
    if (!items.length) break;
    for (const it of items) {
      if (it.sponsored) continue;
      const model = extractModel(it.title); if (!model) continue;
      const price = sane(it.priceText ? yen(it.priceText) : null);
      const prev = out.get(model);
      if (!prev || (price !== null && (prev.price === null || price < prev.price)))
        out.set(model, { price, title: it.title.slice(0, 120), url: it.link ? `https://www.amazon.co.jp${it.link.split('/ref=')[0]}` : '' });
    }
  }
  return out;
}

// ---------- 価格.com: item ページがある時のみ量販店最安 ----------
async function scrapeKakaku(page, model, cachedUrl) {
  try {
    let itemUrl = cachedUrl;
    if (!itemUrl) {
      await page.goto(`https://search.kakaku.com/${encodeURIComponent(model)}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
      itemUrl = await page.$$eval('a[href*="/item/"]', as => as.map(a => a.href).find(h => /\/item\/[A-Z]\d{8,}/.test(h)) || null).catch(() => null);
    }
    if (!itemUrl) return { price: null, itemUrl: null };
    await page.goto(itemUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1800);
    const t = await page.evaluate(() => document.body.innerText.slice(0, 6000));
    // 価格.com は「最安価格 129,800円」表記(¥記号ではなく「円」)
    const m = t.match(/最安価格[^0-9]{0,12}([\d,]{6,9})\s*円/) || t.match(/([\d,]{6,9})\s*円/);
    return { price: sane(m ? yen(m[1]) : null), itemUrl };
  } catch { return { price: null, itemUrl: cachedUrl ?? null }; }
}

// ---------- 楽天: タイトルに型番を含む & 妥当価格の最安 ----------
async function scrapeRakuten(page, model) {
  try {
    // 関連度順(?s=2 の価格昇順だと型番を説明に含むケーブル類が上位を占拠し本体が圏外に落ちる)
    await page.goto(`https://search.rakuten.co.jp/search/mall/${encodeURIComponent(model)}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);
    const cards = await page.evaluate(() => [...document.querySelectorAll('div.searchresultitem')].map(el => {
      const a = el.querySelector('h2 a, .title a, [class*="title"] a, a[href*="item.rakuten"]');
      const pe = el.querySelector('.important, [class*="price"]');
      return { title: (a?.textContent || a?.querySelector('img')?.alt || '').trim(), priceText: (pe?.textContent || '').trim(), href: a?.href || null };
    })).catch(() => []);
    const nm = norm(model);
    const hits = cards.map(c => ({ ...c, price: sane(yen(c.priceText)) }))
      .filter(c => c.price !== null && norm(c.title).includes(nm));
    if (!hits.length) return { price: null, url: null };
    const best = hits.reduce((a, b) => (a.price <= b.price ? a : b));
    return { price: best.price, url: best.href?.split('?')[0] ?? null };
  } catch { return { price: null, url: null }; }
}

// ---------- Qoo10: 検索ページ上の妥当価格の最安 ----------
async function scrapeQoo10(page, model) {
  try {
    const searchUrl = `https://www.qoo10.jp/s/?keyword=${encodeURIComponent(model)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    const prices = await page.evaluate(() => (document.body.innerText.match(/[\d,]{5,7}\s*円/g) || []).map(s => parseInt(s.replace(/[^0-9]/g, ''), 10)));
    const valid = prices.map(sane).filter(p => p !== null);
    if (!valid.length) return { price: null, url: searchUrl };
    return { price: Math.min(...valid), url: searchUrl };
  } catch { return { price: null, url: null }; }
}

// ---------- ニュース: Google News RSS ----------
async function scrapeNews() {
  const queries = [
    '有機EL テレビ セール', 'テレビ 値下げ', 'Amazon プライムデー テレビ',
    '55型 有機EL おすすめ', '4K テレビ 安く 買う',
  ];
  const seen = new Map();
  for (const q of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`;
      const xml = await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8);
      for (const [, block] of items) {
        const pick = tag => (block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`)) || [, ''])[1]
          .replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const rawTitle = pick('title');
        const link = pick('link');
        const pubDate = pick('pubDate');
        const source = pick('source') || rawTitle.split(' - ').at(-1) || '';
        const title = rawTitle.replace(/ - [^-]+$/, '').trim();
        if (!title || !link) continue;
        const key = title.slice(0, 40);
        if (!seen.has(key)) seen.set(key, { title, link, source, pubDate, q });
      }
    } catch (e) { console.error('news query failed:', q, e.message); }
  }
  return [...seen.values()];
}

// ================= main =================
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 1600 }, locale: 'ja-JP',
});
const page = await ctx.newPage();

const data = existsSync(DATA_PATH) ? JSON.parse(readFileSync(DATA_PATH, 'utf8')) : { updatedAt: null, products: {}, news: [] };
data.news ??= [];
for (const p of Object.values(data.products)) { // 旧スキーマ移行
  p.history = p.history.map(h => ('p' in h ? { t: h.t, a: h.p } : h));
  p.urls ??= { a: p.url ?? '', k: null, r: null, q: null };
  delete p.url;
}

const amazon = await scrapeAmazon(page);
console.log(`amazon: ${amazon.size} models found`);

const now = new Date().toISOString();
const drops = [];
const overall = h => { const v = [h.a, h.k, h.r, h.q].filter(x => x != null); return v.length ? Math.min(...v) : null; };

for (const [model, az] of amazon) {
  const entry = data.products[model] ?? { model, brand: detectBrand(az.title), title: az.title, urls: { a: '', k: null, r: null, q: null }, history: [] };
  if (az.title) entry.title = az.title;
  if (az.url) entry.urls.a = az.url;

  const kk = await scrapeKakaku(page, model, entry.kakakuUrl ?? null);
  if (kk.itemUrl) { entry.kakakuUrl = kk.itemUrl; entry.urls.k = kk.itemUrl; }
  await sleep(700);
  const rk = await scrapeRakuten(page, model);
  if (rk.url) entry.urls.r = rk.url;
  await sleep(700);
  const q = await scrapeQoo10(page, model);
  if (q.url) entry.urls.q = q.url;
  await sleep(700);

  const rec = { t: now, a: az.price, k: kk.price, r: rk.price, q: q.price };
  entry.history.push(rec);
  if (entry.history.length > 180) entry.history = entry.history.slice(-180);

  const cur = overall(rec);
  const prevVals = entry.history.slice(0, -1).map(overall).filter(x => x !== null);
  const last = prevVals.at(-1);
  if (cur !== null && last && cur < last) {
    const src = cur === rec.a ? 'Amazon' : cur === rec.k ? '価格.com' : cur === rec.r ? '楽天' : 'Qoo10';
    drops.push(`${entry.brand} ${model}: ¥${last.toLocaleString()} → ¥${cur.toLocaleString()} (${src}, -¥${(last - cur).toLocaleString()})`);
  }
  data.products[model] = entry;
  console.log(`${model}: a=${rec.a} k=${rec.k} r=${rec.r} q=${rec.q}`);
}

// ニュース
const news = await scrapeNews();
const existingKeys = new Set(data.news.map(n => n.title.slice(0, 40)));
const freshNews = news.filter(n => !existingKeys.has(n.title.slice(0, 40)));
for (const n of freshNews) data.news.unshift({ ...n, firstSeen: now });
// 永続保存: 切り捨てず全件アーカイブ(重複はタイトル先頭40字で排除済み)
console.log(`news: ${news.length} fetched, ${freshNews.length} new`);

await browser.close();
data.updatedAt = now;
writeFileSync(DATA_PATH, JSON.stringify(data, null, 1));
console.log(`OK: ${amazon.size} models, ${data.news.length} news items`);

// ---------- 通知 ----------
const notifications = [];
if (drops.length) notifications.push('📉 値下がり\n' + drops.join('\n'));
const saleNews = freshNews.filter(n => /セール|値下げ|プライムデー|割引|お買い得|タイムセール|最安/.test(n.title));
if (saleNews.length) notifications.push('📰 新着セール記事\n' + saleNews.slice(0, 4).map(n => `・${n.title}\n  ${n.link}`).join('\n\n'));
if (notifications.length) {
  // 比較表ページを常に案内(本文末尾 + Clickでタップ遷移)
  const body = notifications.join('\n\n') + `\n\n📊 比較表: ${PAGE_URL}`;
  console.log(body);
  // ntfy の Title ヘッダは非ASCII不可 → RFC2047(UTF-8 base64)でエンコード
  const title = '=?UTF-8?B?' + Buffer.from('📺 テレビ価格&セール').toString('base64') + '?=';
  try {
    await fetch(NTFY_TOPIC, { method: 'POST', headers: { Title: title, Tags: 'tv,moneybag', Priority: 'default', Click: PAGE_URL }, body });
  } catch (e) { console.error('ntfy failed:', e.message); }
}
