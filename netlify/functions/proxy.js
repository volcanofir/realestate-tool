// netlify/functions/proxy.js
// 正確串接新北市開放資料平台實價登錄 API
// API 文件：https://data.ntpc.gov.tw/applications
// Dataset: ACCE802D-58CC-4DFF-9E7A-9ECC517F78BE

const DATASET_ID = 'ACCE802D-58CC-4DFF-9E7A-9ECC517F78BE';
// 正確格式：page 從 0 開始，size 每頁筆數
const BASE_URL = `https://data.ntpc.gov.tw/api/datasets/${DATASET_ID}/json`;

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const params  = event.queryStringParameters || {};
    const community = (params.community || '').trim();
    const dateFrom  = params.dateFrom || '';
    const dateTo    = params.dateTo   || '';
    const page      = parseInt(params.page || '0', 10); // 新北市 page 從 0 開始
    const size      = Math.min(parseInt(params.size || '1000', 10), 1000);

    if (!community) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '請提供 community 參數' }) };
    }

    // 先抓一小批確認欄位名稱
    const probeUrl = `${BASE_URL}?page=0&size=1`;
    const probeResp = await fetch(probeUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!probeResp.ok) throw new Error(`API probe 失敗 ${probeResp.status}`);
    const probeData = await probeResp.json();
    const sampleRow = Array.isArray(probeData) ? probeData[0] : null;

    // 動態偵測欄位名稱
    const FIELD = detectFields(sampleRow);

    // 正式查詢（帶分頁）
    const apiUrl = `${BASE_URL}?page=${page}&size=${size}`;
    const resp = await fetch(apiUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'RealEstateTool/1.0' },
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return { statusCode: resp.status, headers, body: JSON.stringify({ error: `API 錯誤 ${resp.status}`, detail: errText.slice(0, 300) }) };
    }

    const raw = await resp.json();
    const allRows = Array.isArray(raw) ? raw : [];

    // 民國年月換算
    function rocToYearMonth(str) {
      if (!str) return null;
      const clean = String(str).replace(/[\/\-\s]/g, '');
      if (clean.length < 5) return null;
      const roc = parseInt(clean.slice(0, 3), 10);
      const m   = clean.slice(3, 5);
      if (isNaN(roc) || roc < 80 || roc > 200) return null;
      const mNum = parseInt(m, 10);
      if (mNum < 1 || mNum > 12) return null;
      return `${roc + 1911}-${m.padStart(2, '0')}`;
    }

    function toRocDate(yearMonth, type) {
      const [y, m] = yearMonth.split('-').map(Number);
      const roc = String(y - 1911).padStart(3, '0');
      const mStr = String(m).padStart(2, '0');
      if (type === 'start') return `${roc}${mStr}01`;
      const lastDay = new Date(y, m, 0).getDate();
      return `${roc}${mStr}${String(lastDay).padStart(2, '0')}`;
    }

    const rocFrom = dateFrom ? toRocDate(dateFrom, 'start') : '0800101';
    const rocTo   = dateTo   ? toRocDate(dateTo,   'end')   : '2001231';

    function parseFloor(str) {
      if (!str) return 0;
      const n = parseInt(str);
      if (!isNaN(n)) return n;
      const map = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,
        '十':10,'十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16,
        '十七':17,'十八':18,'十九':19,'二十':20,'二十一':21,'二十二':22,
        '二十三':23,'二十四':24,'二十五':25,'三十':30,'四十':40,'五十':50};
      return map[String(str).replace(/[層F樓]/g,'').trim()] || 0;
    }

    // 過濾 + 解析
    const records = allRows
      .filter(r => {
        const addr = String(r[FIELD.addr] || '');
        if (!addr.includes(community)) return false;
        const dateRaw = String(r[FIELD.date] || '').replace(/[\/\-\s]/g,'');
        if (dateRaw < rocFrom || dateRaw > rocTo) return false;
        return true;
      })
      .map(r => {
        const date = rocToYearMonth(r[FIELD.date]);
        if (!date) return null;

        // 面積換算（㎡ → 坪）
        const sqm  = parseFloat(r[FIELD.area] || 0);
        const area = sqm / 3.305785;
        if (area < 5 || area > 600) return null;

        // 價格（元 → 萬）
        const totalRaw   = parseFloat(r[FIELD.total]   || 0);
        const unitRaw    = parseFloat(r[FIELD.unit]    || 0);
        const parkingRaw = parseFloat(r[FIELD.parking] || 0);

        const totalPrice = totalRaw / 10000;
        if (totalPrice < 50) return null;

        const parking    = parkingRaw / 10000;
        const adjTotal   = totalPrice - parking;
        const unitPrice  = unitRaw > 0
          ? (unitRaw * 3.305785) / 10000
          : (area > 0 ? adjTotal / area : 0);

        if (unitPrice < 3 || unitPrice > 600) return null;

        return {
          date,
          address:    String(r[FIELD.addr] || ''),
          area:       Math.round(area      * 10) / 10,
          totalPrice: Math.round(adjTotal  * 10) / 10,
          unitPrice:  Math.round(unitPrice * 10) / 10,
          floor:      parseFloor(r[FIELD.floor]),
          totalFloor: parseInt(r[FIELD.totalFloor] || 0) || 0,
          type:       String(r[FIELD.type] || ''),
        };
      })
      .filter(Boolean);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        total: allRows.length,
        matched: records.length,
        page,
        size,
        fields: FIELD,       // debug 用，之後可移除
        records,
      }),
    };

  } catch (err) {
    console.error('Proxy error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

// 動態偵測欄位名稱（不同版本 API 欄位名可能不同）
function detectFields(sample) {
  if (!sample) {
    // fallback：常見欄位名
    return {
      addr:       '土地區段位置或建物區段門牌',
      date:       '交易年月日',
      area:       '建物移轉總面積平方公尺',
      total:      '總價元',
      unit:       '單價元平方公尺',
      parking:    '車位總價元',
      floor:      '移轉層次',
      totalFloor: '建物現況格局-總層數',
      type:       '建物型態',
    };
  }

  const keys = Object.keys(sample);

  function find(...candidates) {
    for (const c of candidates) {
      const found = keys.find(k => k.includes(c));
      if (found) return found;
    }
    return candidates[0]; // fallback
  }

  return {
    addr:       find('門牌', '位置', 'rps02'),
    date:       find('交易年月日', 'rps07'),
    area:       find('建物移轉總面積', '面積', 'rps15'),
    total:      find('總價元', 'rps21'),
    unit:       find('單價元', 'rps22'),
    parking:    find('車位總價', 'rps25'),
    floor:      find('移轉層次', 'rps09'),
    totalFloor: find('總層數', 'rps10'),
    type:       find('建物型態', 'rps11'),
  };
}
