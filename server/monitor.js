// 监测数据口径都集中在这里：有效读数、折算、日均、总量、超标、许可
const store = require('./store');

// 口径：单日计入统计的有效小时不足 18 小时的，该日不计入平均与总量
const MIN_VALID_HOURS_PER_DAY = 18;
// 口径：量程判定只针对浓度类指标；流量、氧含量是配对参数，不参与量程判定
const RANGE_METRICS = ['COD', '氨氮'];

function plantOf(data, id) {
  return data.plants.find((p) => p.id === id) || null;
}
function outletOf(data, id) {
  return data.outlets.find((o) => o.id === id) || null;
}
function deviceOf(data, id) {
  return data.devices.find((d) => d.id === id) || null;
}

function readingsOf(data, query) {
  const q = query || {};
  let rows = data.readings.slice();
  if (q.outletId) rows = rows.filter((r) => r.outletId === q.outletId);
  if (q.deviceId) rows = rows.filter((r) => r.deviceId === q.deviceId);
  if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
  if (q.day) rows = rows.filter((r) => store.dayOf(r.at) === q.day);
  if (q.month) rows = rows.filter((r) => store.monthOf(r.at) === q.month);
  return rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// 口径：只有有效小时值参与统计——标记为有效、设备状态正常；浓度类指标还要求数值在量程内
function isCounted(reading, device, settings) {
  if (!reading || reading.flag !== '有效') return false;
  if (!device || device.status !== '正常') return false;
  const v = Number(reading.value);
  if (!Number.isFinite(v)) return false;
  if (RANGE_METRICS.includes(reading.metric)) {
    return v >= Number(settings.rangeMin) && v <= Number(settings.rangeMax);
  }
  return true;
}

// 口径：折算浓度 = 实测浓度 × (21 − 基准氧) / (21 − 实测氧含量)；氧含量缺失按基准氧处理
// 折算浓度取两位小数后参与平均与总量计算，导出数据可按同一公式手工复核
function effectiveConcentration(data, reading, oxygen) {
  const base = Number(data.settings.oxygenBaseline);
  let oxy = oxygen;
  if (oxy === undefined) oxy = oxygenAt(data, reading);
  if (oxy === null || oxy === '' || !Number.isFinite(Number(oxy))) oxy = base;
  const value = Number(reading.value);
  const denom = 21 - Number(oxy);
  if (!Number.isFinite(value) || denom <= 0) return store.round(Number.isFinite(value) ? value : 0, 2);
  return store.round((value * (21 - base)) / denom, 2);
}

// 小时值里的氧含量（同排放口同时刻的氧含量读数）
function oxygenAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '氧含量' && r.at === reading.at);
  return row ? Number(row.value) : null;
}

function flowAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '流量' && r.at === reading.at);
  return row ? Number(row.value) : 0;
}

// 口径：排污单位停产、或排放口停用时段的小时值不计入统计（保留可查）
function isStopped(data, reading) {
  const outlet = outletOf(data, reading.outletId);
  const plant = outlet ? plantOf(data, outlet.plantId) : null;
  return !!(outlet && plant && (outlet.status === '停用' || plant.status === '停产'));
}

// 一天里该排放口某指标的逐小时明细
function dayRows(data, outletId, metric, day) {
  const rows = readingsOf(data, { outletId, metric, day });
  return rows.map((row) => {
    const device = deviceOf(data, row.deviceId);
    const stopped = isStopped(data, row);
    const counted = !stopped && isCounted(row, device, data.settings);
    const oxygen = oxygenAt(data, row);
    return {
      id: row.id,
      at: row.at,
      hour: Number(String(row.at).slice(11, 13)),
      value: Number(row.value),
      source: row.source,
      flag: row.flag,
      deviceCode: device ? device.code : '',
      deviceStatus: device ? device.status : '',
      stopped,
      oxygen,
      flow: flowAt(data, row),
      counted,
      concentration: counted ? effectiveConcentration(data, row, oxygen) : 0,
    };
  });
}

// 日均：按小时流量加权（流量合计为 0 时按算术平均）；有效小时不足 18 小时或补录超上限的，该日不计入并写明原因
function dailyStats(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = dayRows(data, outletId, metric, day);
  const counted = rows.filter((r) => r.counted);
  const imputedHours = counted.filter((r) => r.source === '补录').length;
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const flowTotal = counted.reduce((acc, r) => acc + r.flow, 0);
  let average = 0;
  if (counted.length) {
    if (flowTotal > 0) average = counted.reduce((acc, r) => acc + r.concentration * r.flow, 0) / flowTotal;
    else average = counted.reduce((acc, r) => acc + r.concentration, 0) / counted.length;
  }
  let invalidReason = '';
  if (!counted.length) invalidReason = '当日没有计入统计的有效小时值';
  else if (counted.length < MIN_VALID_HOURS_PER_DAY) invalidReason = '有效小时不足 ' + MIN_VALID_HOURS_PER_DAY + ' 小时（实际 ' + counted.length + ' 小时）';
  else if (imputedHours > Number(settings.maxImputeHoursPerDay)) invalidReason = '补录小时超过上限 ' + Number(settings.maxImputeHoursPerDay) + ' 小时（实际 ' + imputedHours + ' 小时）';
  const valid = !invalidReason;
  return {
    day,
    outletId,
    metric,
    rows,
    countedHours: counted.length,
    imputedHours,
    average: store.round(average, 2),
    valid,
    invalidReason,
    limit,
    exceed: valid && average > limit,
    flowTotal: store.round(flowTotal, 1),
  };
}

function dailySeries(data, outletId, metric, month) {
  const days = store.daysInMonth(month);
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    const day = month + '-' + String(d).padStart(2, '0');
    if (!readingsOf(data, { outletId, metric, day }).length) continue;
    out.push(dailyStats(data, outletId, metric, day));
  }
  return out;
}

// 月均值：按有效天数平均（分母是有效天数，不是当月天数）
function monthAverage(data, outletId, metric, month) {
  const series = dailySeries(data, outletId, metric, month).filter((s) => s.valid);
  if (!series.length) return 0;
  const sum = series.reduce((acc, s) => acc + s.average, 0);
  return store.round(sum / series.length, 2);
}

// 每小时排放量（吨）：折算浓度(mg/L) × 流量(m³/h) × 1000 / 换算系数
function hourTons(settings, concentration, flow) {
  return (concentration * flow * 1000) / Number(settings.tonsDivisor);
}

// 月总量（吨）：逐小时按时刻配对累加（浓度与流量取同一时刻的那一对），无效日不计入
function monthTotal(data, outletId, metric, month) {
  let tons = 0;
  for (const s of dailySeries(data, outletId, metric, month)) {
    if (!s.valid) continue;
    for (const r of s.rows) if (r.counted) tons += hourTons(data.settings, r.concentration, r.flow);
  }
  return store.round(tons, 4);
}

// 季度总量：季度内逐小时累加（即当季各月总量之和），不做任何按天外推
function quarterTotal(data, outletId, metric, quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  let tons = 0;
  for (const m of [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3]) {
    tons += monthTotal(data, outletId, metric, y + '-' + String(m).padStart(2, '0'));
  }
  return store.round(tons, 4);
}

// 季度许可量：年许可量 × 该季度实际天数 / 全年天数
function quarterPermitTons(data, metric, quarter) {
  const settings = data.settings;
  const annual = metric === '氨氮' ? Number(settings.annualPermitAmmoniaTons) : Number(settings.annualPermitCodTons);
  const [y] = String(quarter).split('-Q').map(Number);
  let yearDays = 0;
  for (let m = 1; m <= 12; m += 1) yearDays += store.daysInMonth(y + '-' + String(m).padStart(2, '0'));
  return store.round((annual * store.daysInQuarter(quarter)) / yearDays, 4);
}

// 许可年窗口：以许可年起始日的月日为界，取包含今天的那个许可年 [start, end)
function permitYearWindow(startText, today) {
  const parts = String(startText || '').split('-');
  if (parts.length !== 3 || !/^\d{2}$/.test(parts[1]) || !/^\d{2}$/.test(parts[2])) return null;
  const md = parts[1] + '-' + parts[2];
  const y = Number(String(today).slice(0, 4));
  const startYear = String(today).slice(5) < md ? y - 1 : y;
  return { start: startYear + '-' + md, end: startYear + 1 + '-' + md };
}

// 年累计按许可年累计，跨自然年不重置也不带入其他许可年；按请求内缓存避免重复汇总
const accumulatedCache = new WeakMap();
function accumulatedTons(data, metric) {
  let byData = accumulatedCache.get(data);
  if (byData && byData[metric] !== undefined) return byData[metric];
  const today = store.nowText().slice(0, 10);
  let tons = 0;
  for (const outlet of data.outlets) {
    const plant = plantOf(data, outlet.plantId);
    const win = permitYearWindow(plant && plant.permitYearStart ? plant.permitYearStart : data.settings.permitYearStart, today);
    if (!win) continue;
    const days = Array.from(new Set(
      data.readings.filter((r) => r.outletId === outlet.id && r.metric === metric).map((r) => store.dayOf(r.at))
    )).filter((d) => d >= win.start && d < win.end);
    for (const day of days) {
      const s = dailyStats(data, outlet.id, metric, day);
      if (!s.valid) continue;
      for (const r of s.rows) if (r.counted) tons += hourTons(data.settings, r.concentration, r.flow);
    }
  }
  const result = store.round(tons, 4);
  if (!byData) { byData = {}; accumulatedCache.set(data, byData); }
  byData[metric] = result;
  return result;
}

// 超标：日均超过限值，或者小时值超过限值达到规定次数，二者满足其一即超标
function exceedance(data, outletId, metric, month) {
  const settings = data.settings;
  const series = dailySeries(data, outletId, metric, month);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const exceedDays = series.filter((s) => s.exceed).map((s) => s.day);
  let exceedHours = 0;
  for (const s of series) {
    for (const row of s.rows) if (row.counted && row.concentration > limit) exceedHours += 1;
  }
  const hourly = exceedHours >= Number(settings.hourlyExceedCountLimit);
  return {
    month,
    outletId,
    metric,
    limit,
    exceedDays,
    exceedDaysCount: exceedDays.length,
    exceedHours,
    hourlyExceed: hourly,
    exceeded: exceedDays.length > 0 || hourly,
    monthAverage: monthAverage(data, outletId, metric, month),
  };
}

function outletsOf(data, plantId) {
  return data.outlets.filter((o) => o.plantId === plantId);
}

// 排放口汇总：逐指标给出月均、月总量、超标情况
function outletSummary(data, outletId, month) {
  const outlet = outletOf(data, outletId);
  const settings = data.settings;
  const metrics = ['COD', '氨氮'];
  const rows = metrics.map((metric) => {
    const ex = exceedance(data, outletId, metric, month);
    return {
      metric,
      monthAverage: ex.monthAverage,
      monthTotalTons: monthTotal(data, outletId, metric, month),
      exceedDaysCount: ex.exceedDaysCount,
      exceedHours: ex.exceedHours,
      exceeded: ex.exceeded,
      limit: ex.limit,
    };
  });
  const devices = data.devices.filter((d) => d.outletId === outletId).map((d) => Object.assign({}, d, {
    readingCount: data.readings.filter((r) => r.deviceId === d.id).length,
  }));
  return {
    outlet,
    plant: outlet ? plantOf(data, outlet.plantId) : null,
    month,
    rows,
    devices,
    quarterTotalCod: quarterTotal(data, outletId, 'COD', store.quarterOf(month)),
    permitCodTons: quarterPermitTons(data, 'COD', store.quarterOf(month)),
    annualPermitCodTons: Number(settings.annualPermitCodTons),
    accumulatedCodTons: accumulatedTons(data, 'COD'),
    accumulatedAmmoniaTons: accumulatedTons(data, '氨氮'),
    settings,
  };
}

module.exports = {
  plantOf, outletOf, deviceOf,
  readingsOf, isCounted, effectiveConcentration, oxygenAt, flowAt, isStopped,
  dayRows, dailyStats, dailySeries, monthAverage, monthTotal, quarterTotal, quarterPermitTons, accumulatedTons,
  exceedance, outletsOf, outletSummary,
  MIN_VALID_HOURS_PER_DAY, RANGE_METRICS,
};
