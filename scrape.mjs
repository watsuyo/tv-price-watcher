// Amazon 55型有機ELテレビ 価格ウォッチャー
// 検索結果ページ(53.0-61.9in / 有機EL / 4K / ¥85,000-180,000)から価格を取得し、
// docs/data.json に履歴を蓄積。前回より値下がりした機種は ntfy.sh/ccr へ通知。
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(ROOT, 'docs', 'data.json');
const NTFY_TOPIC = 'https://ntfy.sh/ccr';

const SEARCH_URL =
  'https://www.amazon.co.jp/s?k=4K+%E6%9C%89%E6%A9%9Fel+%E3%83%86%E3%83%AC%E3%83%93' +
  '&rh=p_n_feature_three_browse-bin%3A213301351051' +
  '%2Cp_n_feature_two_browse-bin%3A4910340051' +
  '%2Cp_n_g-1003296671111%3A10518582051' +
  '%2Cp_36%3A8500000-18000000&dc&reform=4k&rnid=401022011';

// 商品名から型番を抽出するパターン(メーカー横断)
const MODEL_PATTERNS = [
  /OLED\d{2}[A-Z]\d[A-Z]{3}/i,        // LG: OLED55B5PJA
  /4T-C\d{2}[A-Z]{2}\d/i,             // シャープ: 4T-C55GQ3
  /\b\d{2}X\d{4}[A-Z]\b/i,            // REGZA: 55X8900L
  /TH-\d{2}[A-Z]{2}\d{4}/i,           // パナソニック: TH-55MZ1800
  /XRJ-\d{2}[A-Z]\d{2}[A-Z]?/i,       // ソニー: XRJ-55A80L
  /K-\d{2}X[A-Z]\d{2}[A-Z]?/i,        // ソニー(2024-): K-55XR80
  /\b\d{2}U[A-Z]?\d[A-Z]+\b/i,        // ハイセンス等
];

function extractModel(title) {
  for (const re of MODEL_PATTERNS) {
    const m = title.match(re);
    if (m) return m[0].toUpperCase();
  }
  return null;
}

function detectBrand(title) {
  const map = [
    ['LG', /\bLG\b/i], ['シャープ', /シャープ|AQUOS/], ['REGZA', /REGZA|レグザ/],
    ['パナソニック', /パナソニック|VIERA/], ['ソニー', /ソニー|BRAVIA/i], ['ハイセンス', /ハイセンス|Hisense/i],
  ];
  for (const [brand, re] of map) if (re.test(title)) return brand;
  return 'その他';
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 1600 },
    locale: 'ja-JP',
  });
  const page = await ctx.newPage();
  const results = [];

  for (let pageNum = 1; pageNum <= 2; pageNum++) {
    const url = pageNum === 1 ? SEARCH_URL : `${SEARCH_URL}&page=${pageNum}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    const items = await page.$$eval(
      'div[data-component-type="s-search-result"]',
      els => els.map(el => {
        const title = el.querySelector('h2')?.textContent.trim() ?? '';
        const priceText = el.querySelector('.a-price .a-offscreen')?.textContent.trim() ?? '';
        const link = el.querySelector('h2 a, a.a-link-normal')?.getAttribute('href') ?? '';
        const sponsored = !!el.querySelector('.puis-sponsored-label-text');
        return { title, priceText, link, sponsored };
      })
    ).catch(() => []);
    results.push(...items);
    if (items.length === 0) break;
  }
  await browser.close();
  return results;
}

function loadData() {
  if (existsSync(DATA_PATH)) return JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  return { updatedAt: null, products: {} };
}

async function notify(title, body) {
  try {
    await fetch(NTFY_TOPIC, {
      method: 'POST',
      headers: { Title: title, Tags: 'tv,moneybag', Priority: 'default' },
      body,
    });
  } catch (e) {
    console.error('ntfy failed:', e.message);
  }
}

const raw = await scrape();
const data = loadData();
const now = new Date().toISOString();
const drops = [];

for (const item of raw) {
  if (item.sponsored) continue;
  const model = extractModel(item.title);
  if (!model) continue;
  const price = item.priceText ? parseInt(item.priceText.replace(/[^0-9]/g, ''), 10) : null;
  if (price !== null && (price < 85000 || price > 250000)) continue; // パーツ等の誤マッチ除外

  const prev = data.products[model];
  const entry = prev ?? {
    model,
    brand: detectBrand(item.title),
    title: item.title.slice(0, 120),
    url: item.link ? `https://www.amazon.co.jp${item.link.split('/ref=')[0]}` : '',
    history: [],
  };
  // 同一実行内の重複(同型番が複数出品)は安い方を採用
  const dup = entry.history.find(h => h.t === now);
  if (dup) {
    if (price !== null && (dup.p === null || price < dup.p)) dup.p = price;
  } else {
    entry.history.push({ t: now, p: price });
  }

  // 値下がり検知(前回の有効価格と比較)
  if (!dup && price !== null) {
    const prevPrices = entry.history.slice(0, -1).map(h => h.p).filter(p => p !== null);
    const lastPrice = prevPrices.at(-1);
    if (lastPrice && price < lastPrice) {
      drops.push(`${entry.brand} ${model}: ¥${lastPrice.toLocaleString()} → ¥${price.toLocaleString()} (-¥${(lastPrice - price).toLocaleString()})`);
    }
  }
  data.products[model] = entry;
}

// 古い履歴の間引き(90日分まで)
for (const p of Object.values(data.products)) {
  if (p.history.length > 180) p.history = p.history.slice(-180);
}

data.updatedAt = now;
writeFileSync(DATA_PATH, JSON.stringify(data, null, 1));

const found = Object.keys(data.products).length;
console.log(`OK: ${raw.length} items scraped, ${found} models tracked`);
if (drops.length > 0) {
  console.log('DROPS:\n' + drops.join('\n'));
  await notify('📉 有機ELテレビ 値下がり', drops.join('\n'));
}
