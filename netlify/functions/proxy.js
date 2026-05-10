// netlify/functions/proxy.js
// 新北市不動產實價登錄 API proxy
// 欄位已確認：rps02=地址, rps07_yyymmddroc=日期, rps15_area=面積(㎡)
//             rps21=總價(元), rps22=單價(元/㎡), rps25=車位總價(元)
//             rps09=樓層(中文), rps10=總層數, rps11=建物型態

const DATASET_ID = 'ACCE802D-58CC-4DFF-9E7A-9ECC517F78BE';
const BASE_URL   = `https://data.ntpc.gov.tw/api/datasets/${DATASET_ID}/json`;

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':                 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const p         = event.queryStringParameters || {};
    const community = (p.community || '').trim();
    const dateFrom  = p.dateFrom || '';
    const dateTo    = p.dateTo   || '';
    const page      = parseInt(p.page || '0', 10);
    const size      = Math.min(parseInt(p.size || '1000', 10), 1000);

    if (!community) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '請提供 community 參數' }) };
    }

    // ── 呼叫新北市 API ──
    const apiUrl = `${BASE_URL}?page=${page}&size=${size}`;
    const resp = await fetch(apiUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'RealEstateTool/1.0' },
      signal: AbortSignal.timeout(25000),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      return { statusCode: resp.status, headers, body: JSON.stringify({ error: `API 錯誤 ${resp.status}`, detail: txt.slice(0, 300) }) };
    }

    const allRows = await resp.json(); // 直接是 array

    // ── 日期工具 ──
    function rocToYearMonth(str) {
      // 格式：YYYMMDD（民國）例如 1140516 → 2025-05
      const s = String(str || '').replace(/\D/g, '');
      if (s.length < 5) return null;
      const roc = parseInt(s.slice(0, 3), 10);
      const m   = s.slice(3, 5);
      if (isNaN(roc) || roc < 80) return null;
      return `${roc + 1911}-${m.padStart(2, '0')}`;
    }

    function toRocInt(yearMonth, type) {
      // YYYY-MM → 民國整數 YYYMMDD
      const [y, m] = yearMonth.split('-').map(Number);
      const roc  = y - 1911;
      const mStr = String(m).padStart(2, '0');
      if (type === 'start') return parseInt(`${roc}${mStr}01`);
      const last = new Date(y, m, 0).getDate();
      return parseInt(`${roc}${mStr}${String(last).padStart(2, '0')}`);
    }

    const rocFrom = dateFrom ? toRocInt(dateFrom, 'start') : 0;
    const rocTo   = dateTo   ? toRocInt(dateTo,   'end')   : 9999999;

    // ── 樓層解析（中文數字）──
    function parseFloor(str) {
      if (!str) return 0;
      const n = parseInt(str);
      if (!isNaN(n)) return n;
      const s = String(str).replace(/[層樓F]/g, '').trim();
      const map = {
        '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,
        '十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16,'十七':17,
        '十八':18,'十九':19,'二十':20,'二十一':21,'二十二':22,'二十三':23,
        '二十四':24,'二十五':25,'二十六':26,'二十七':27,'二十八':28,'二十九':29,
        '三十':30,'三十一':31,'三十二':32,'三十三':33,'三十四':34,'三十五':35,
        '四十':40,'四十五':45,'五十':50,
      };
      return map[s] || 0;
    }

    // ── 過濾 + 解析 ──
    const records = allRows
      .filter(r => {
        // 1. 社區名稱比對（rps02 = 門牌地址）
        if (!String(r.rps02 || '').includes(community)) return false;

        // 2. 日期範圍（rps07_yyymmddroc = 民國年月日整數）
        const dateInt = parseInt(String(r.rps07_yyymmddroc || '').replace(/\D/g, '')) || 0;
        if (dateInt < rocFrom || dateInt > rocTo) return false;

        return true;
      })
      .map(r => {
        const date = rocToYearMonth(r.rps07_yyymmddroc);
        if (!date) return null;

        // 面積：rps15_area 單位是平方公尺，換算成坪
        const sqm  = parseFloat(r.rps15_area || 0);
        const area = sqm / 3.305785;
        if (area < 5 || area > 600) return null;

        // 總價（元 → 萬）
        const totalPrice = parseFloat(r.rps21_amountsunitdollars || 0) / 10000;
        if (totalPrice < 50) return null;

        // 車位總價（元 → 萬），排除後計算淨總價
        const parking  = parseFloat(r.rps25_amountsunitdollars || 0) / 10000;
        const adjTotal = totalPrice - parking;

        // 單價：rps22 是元/㎡，換算成萬/坪
        const unitRaw  = parseFloat(r.rps22_amountsunitdollars || 0);
        let unitPrice  = unitRaw > 0
          ? (unitRaw * 3.305785) / 10000
          : (area > 0 ? adjTotal / area : 0);

        if (unitPrice < 3 || unitPrice > 600) return null;

        return {
          date,
          address:    String(r.rps02    || ''),
          district:   String(r.district || ''),
          area:       Math.round(area      * 10) / 10,
          totalPrice: Math.round(adjTotal  * 10) / 10,
          unitPrice:  Math.round(unitPrice * 10) / 10,
          floor:      parseFloor(r.rps09),
          totalFloor: parseFloor(r.rps10),
          type:       String(r.rps11 || ''),
        };
      })
      .filter(Boolean);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        total:   allRows.length,
        matched: records.length,
        page,
        size,
        records,
      }),
    };

  } catch (err) {
    console.error('Proxy error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
