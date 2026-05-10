// netlify/functions/proxy.js
// 轉發新北市政府開放資料平台的實價登錄 API，繞過瀏覽器 CORS 限制
// Dataset: 不動產實價登錄資訊-買賣案件
// https://data.ntpc.gov.tw/datasets/acce802d-58cc-4dff-9e7a-9ecc517f78be

const DATASET_ID = 'acce802d-58cc-4dff-9e7a-9ecc517f78be';
const BASE_URL   = `https://data.ntpc.gov.tw/api/v1/rest/datastore/${DATASET_ID}`;

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};

    // ── 必填參數 ──
    const community = params.community || '';
    const dateFrom  = params.dateFrom  || '';   // YYYY-MM
    const dateTo    = params.dateTo    || '';   // YYYY-MM
    const offset    = parseInt(params.offset || '0', 10);
    const limit     = Math.min(parseInt(params.limit || '1000', 10), 1000);

    if (!community) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: '請提供 community 參數' }),
      };
    }

    // ── 組合新北市 API 查詢字串 ──
    // rps02 = 土地區段位置/建物區段門牌（包含社區名稱）
    // rps07_yyymmddroc = 交易年月日（民國年 YYYMMDD）
    const apiParams = new URLSearchParams({
      limit,
      offset,
      // 社區名稱模糊比對
      'rps02[like]': `%${community}%`,
    });

    // 日期範圍轉換：西元 YYYY-MM → 民國 YYYMMDD
    if (dateFrom) {
      const rocFrom = toRocDate(dateFrom, 'start');
      apiParams.append('rps07_yyymmddroc[gte]', rocFrom);
    }
    if (dateTo) {
      const rocTo = toRocDate(dateTo, 'end');
      apiParams.append('rps07_yyymmddroc[lte]', rocTo);
    }

    const apiUrl = `${BASE_URL}?${apiParams.toString()}`;

    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'RealEstateTool/1.0',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: `上游 API 錯誤 ${response.status}`, detail: errText }),
      };
    }

    const raw = await response.json();

    // ── 轉換欄位為前端友好格式 ──
    const records = (raw.result?.records || []).map(parseRecord).filter(Boolean);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        total:   raw.result?.total   || 0,
        offset:  raw.result?.offset  || offset,
        limit:   raw.result?.limit   || limit,
        records,
      }),
    };

  } catch (err) {
    console.error('Proxy error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ── 民國日期轉換 ──
// 西元 YYYY-MM → 民國 YYYMMDD（start=月初 end=月底）
function toRocDate(yearMonth, type) {
  const [y, m] = yearMonth.split('-').map(Number);
  const roc = y - 1911;
  const rocStr = String(roc).padStart(3, '0');
  const mStr   = String(m).padStart(2, '0');
  if (type === 'start') return `${rocStr}${mStr}01`;
  // end: 月底
  const lastDay = new Date(y, m, 0).getDate();
  return `${rocStr}${mStr}${String(lastDay).padStart(2, '0')}`;
}

// ── 欄位對應 & 資料清洗 ──
function parseRecord(r) {
  // 民國年月日 → 西元 YYYY-MM
  const dateStr = r['rps07_yyymmddroc'] || '';
  const date = rocToYearMonth(dateStr);
  if (!date) return null;

  // 建物面積（平方公尺→坪，1坪=3.305785㎡）
  const sqm  = parseFloat(r['rps15_area'] || 0);
  const area  = sqm / 3.305785;
  if (area < 5) return null; // 排除異常小坪數

  // 總價（元→萬）
  const totalPrice = parseFloat(r['rps21_amountsunitdollars'] || 0) / 10000;
  if (totalPrice < 100) return null; // 排除異常低總價

  // 單價（元/平方公尺→萬/坪）
  // 有些資料集直接提供單價，有些需自算
  let unitPrice = parseFloat(r['rps22_amountsunitdollars'] || 0);
  if (unitPrice > 0) {
    // 原始是 元/㎡，換算成 萬/坪
    unitPrice = (unitPrice * 3.305785) / 10000;
  } else if (area > 0) {
    unitPrice = totalPrice / area;
  }
  if (unitPrice < 5 || unitPrice > 500) return null; // 排除異常單價

  // 車位（排除車位總價影響）
  const parkingPrice = parseFloat(r['rps25_amountsunitdollars'] || 0) / 10000;

  return {
    date,
    address:     r['rps02'] || '',
    area:        Math.round(area * 10) / 10,
    totalPrice:  Math.round((totalPrice - parkingPrice) * 10) / 10,
    unitPrice:   Math.round(unitPrice * 10) / 10,
    floor:       parseFloor(r['rps09'] || ''),
    totalFloor:  parseInt(r['rps10'] || 0) || 0,
    type:        r['rps11'] || '',
    parking:     r['rps23'] || '',
    district:    r['district'] || '',
  };
}

// 民國日期 YYYMMDD → 西元 YYYY-MM
function rocToYearMonth(str) {
  if (!str || str.length < 7) return null;
  const roc = parseInt(str.slice(0, 3), 10);
  const m   = str.slice(3, 5);
  if (isNaN(roc) || roc < 80) return null;
  return `${roc + 1911}-${m}`;
}

// 樓層解析（如「三層」「4F」等各種格式）
function parseFloor(str) {
  const n = parseInt(str);
  return isNaN(n) ? 0 : n;
}
