// 监测数据口径都集中在这里：有效读数、折算、日均、总量、超标、许可
// 本文件是页面统计与「对外提供」导出共用的唯一口径来源，改动口径会直接改变口径版本快照（见 caliber.js）
const store = require('./store');

const MIN_VALID_HOURS_PER_DAY = 18;

function plantOf(data, id) {
  return data.plants.find((p) => p.id === id) || null;
}
function outletOf(data, id) {
  return data.outlets.find((o) => o.id === id) || null;
}
function deviceOf(data, id) {
  return data.devices.find((d) => d.id === id) || null;
}

function inTimeRange(at, q) {
  if (q && q.from && String(at) < String(q.from)) return false;
  if (q && q.to && String(at) > String(q.to)) return false;
  return true;
}

function readingsOf(data, query) {
  const q = query || {};
  let rows = data.readings.slice();
  if (q.outletId) rows = rows.filter((r) => r.outletId === q.outletId);
  if (q.deviceId) rows = rows.filter((r) => r.deviceId === q.deviceId);
  if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
  if (Array.isArray(q.metrics)) rows = rows.filter((r) => q.metrics.includes(r.metric));
  if (q.day) rows = rows.filter((r) => store.dayOf(r.at) === q.day);
  if (q.month) rows = rows.filter((r) => store.monthOf(r.at) === q.month);
  if (q.from || q.to) rows = rows.filter((r) => inTimeRange(r.at, q));
  return rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// 口径①：只有有效小时值参与统计——标记为「有效」、设备状态「正常」、数值合理，三条同时满足。
// 污染物浓度（COD、氨氮）要求在浓度量程内；流量、氧含量等辅助量不套浓度量程，非负有限即可。
function isCounted(reading, device, settings) {
  if (!reading || reading.flag !== '有效') return false;
  if (!device || device.status !== '正常') return false;
  const v = Number(reading.value);
  if (!Number.isFinite(v)) return false;
  if (reading.metric === 'COD' || reading.metric === '氨氮') {
    if (v < Number(settings.rangeMin) || v > Number(settings.rangeMax)) return false;
  } else if (v < 0) {
    return false;
  }
  return true;
}

// 一条读数「不计入」的具体原因（页面与对外清单用同一套判定，对外要能说明为什么不计入）
function excludedReason(data, reading) {
  const device = deviceOf(data, reading.deviceId);
  const settings = data.settings;
  if (reading.flag !== '有效') return '数据标记为「' + reading.flag + '」';
  if (!device) return '监测设备已不在台账中';
  if (device.status !== '正常') return '设备状态为「' + device.status + '」';
  const v = Number(reading.value);
  if (!Number.isFinite(v) || v < 0) return '数值为负或不是有效数字';
  if ((reading.metric === 'COD' || reading.metric === '氨氮') && (v < Number(settings.rangeMin) || v > Number(settings.rangeMax))) {
    return '浓度数值超出量程（' + settings.rangeMin + '～' + settings.rangeMax + '）';
  }
  if (isStopped(data, reading)) return '单位停产或排放口停用时段';
  return '';
}

// 口径②：折算浓度 = 实测浓度 × (21 − 基准氧) / (21 − 实测氧含量)；氧含量缺失按基准氧处理（等价于不折算）
function effectiveConcentration(reading, settings, oxygen) {
  const value = Number(reading.value);
  const baseline = Number(settings.oxygenBaseline);
  let measured = baseline;
  if (oxygen !== null && oxygen !== undefined && oxygen !== '' && Number.isFinite(Number(oxygen))) measured = Number(oxygen);
  const denom = 21 - measured;
  if (!(denom > 0)) return store.round(value, 3); // 氧含量读数异常时不给负浓度，按实测值给出
  return store.round(value * (21 - baseline) / denom, 3);
}

// 小时值里的氧含量（同排放口同时刻的氧含量读数）
function oxygenAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '氧含量' && r.at === reading.at);
  return row ? Number(row.value) : null;
}

// 小时值里的流量（同排放口同时刻的流量读数，必须同一时刻配对）
function flowAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '流量' && r.at === reading.at);
  return row ? Number(row.value) : 0;
}

// 口径⑧：单位停产或排放口停用的时段保留可查，但不计入统计
function isStopped(data, reading) {
  const outlet = outletOf(data, reading.outletId);
  const plant = outlet ? plantOf(data, outlet.plantId) : null;
  return !!(outlet && plant && (outlet.status === '停用' || plant.status === '停产'));
}

// 某条读数是否最终计入统计（有效判定 + 停产停用剔除）
function isIncluded(data, reading) {
  const device = deviceOf(data, reading.deviceId);
  return isCounted(reading, device, data.settings) && !isStopped(data, reading);
}

// 一天里该排放口某指标的逐小时明细
function dayRows(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = readingsOf(data, { outletId, metric, day });
  return rows.map((row) => {
    const device = deviceOf(data, row.deviceId);
    const oxygen = oxygenAt(data, row);
    const counted = isIncluded(data, row);
    return {
      id: row.id,
      at: row.at,
      hour: Number(String(row.at).slice(11, 13)),
      value: Number(row.value),
      source: row.source,
      flag: row.flag,
      deviceCode: device ? device.code : '',
      deviceStatus: device ? device.status : '',
      oxygen,
      flow: flowAt(data, row),
      stopped: isStopped(data, row),
      counted,
      excludedReason: counted ? '' : excludedReason(data, row),
      concentration: counted ? effectiveConcentration(row, settings, oxygen) : 0,
    };
  });
}

// 口径③：日均按小时流量加权；有效小时不足 18、或补录小时超过上限的，该日不计入平均与总量
function dailyStats(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = dayRows(data, outletId, metric, day);
  const counted = rows.filter((r) => r.counted);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const imputedHours = counted.filter((r) => r.source === '补录').length;
  const flowTotal = store.round(counted.reduce((acc, r) => acc + r.flow, 0), 1);
  if (!counted.length) {
    return { day, outletId, metric, rows, countedHours: 0, imputedHours: 0, average: 0, valid: false, reason: '当日没有有效小时值', limit, exceed: false, flowTotal: 0, flowWeighted: !!settings.flowWeighted };
  }
  let reason = '';
  if (counted.length < MIN_VALID_HOURS_PER_DAY) reason = '有效小时仅 ' + counted.length + ' 小时，不足 ' + MIN_VALID_HOURS_PER_DAY + ' 小时';
  else if (imputedHours > Number(settings.maxImputeHoursPerDay)) reason = '补录小时 ' + imputedHours + ' 个，超过单日上限 ' + settings.maxImputeHoursPerDay + ' 个';
  const valid = !reason;
  let average = 0;
  let flowWeighted = false;
  if (valid) {
    if (settings.flowWeighted !== false) {
      const weighted = counted.reduce((acc, r) => acc + r.concentration * r.flow, 0);
      if (flowTotal > 0) { average = store.round(weighted / flowTotal, 2); flowWeighted = true; }
    }
    if (!flowWeighted) average = store.round(counted.reduce((acc, r) => acc + r.concentration, 0) / counted.length, 2);
  }
  return {
    day,
    outletId,
    metric,
    rows,
    countedHours: counted.length,
    imputedHours,
    average,
    valid,
    reason,
    limit,
    exceed: valid && average > limit,
    flowTotal,
    flowWeighted,
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

// 月均值：分母是有效天数，不是当月天数
function monthAverage(data, outletId, metric, month) {
  const validDays = dailySeries(data, outletId, metric, month).filter((s) => s.valid);
  if (!validDays.length) return 0;
  const sum = validDays.reduce((acc, s) => acc + s.average, 0);
  return store.round(sum / validDays.length, 2);
}

// 口径⑤：逐小时排放质量（毫克）= 折算浓度(mg/L) × 流量(m³/h) × 1000(升/m³)；浓度与流量必须同一时刻配对
// 对一组已经筛好的浓度读数累加，调用方负责时段与有效性筛选
function massOverRows(data, rows, settings) {
  let mg = 0;
  for (const row of rows) {
    if (!isIncluded(data, row)) continue;
    const oxygen = oxygenAt(data, row);
    mg += effectiveConcentration(row, settings, oxygen) * flowAt(data, row);
  }
  return mg;
}

// 月总量（吨）：当月逐小时配对累加，不做按天外推
function monthTotal(data, outletId, metric, month) {
  const settings = data.settings;
  const rows = readingsOf(data, { outletId, metric, month });
  return store.round(massOverRows(data, rows, settings) * 1000 / Number(settings.tonsDivisor), 4);
}

// 任意时段总量（吨），逐小时配对累加
function periodTotal(data, outletId, metric, from, to) {
  const settings = data.settings;
  const rows = readingsOf(data, outletId ? { outletId, metric: metric, from, to } : { metric, from, to });
  return store.round(massOverRows(data, rows, settings) * 1000 / Number(settings.tonsDivisor), 4);
}

// 季度总量：季度内三个月逐小时累加之和
function quarterTotal(data, outletId, metric, quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  const months = [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3].map((m) => y + '-' + String(m).padStart(2, '0'));
  const total = months.reduce((acc, m) => acc + monthTotal(data, outletId, metric, m), 0);
  return store.round(total, 4);
}

function daysInYear(year) {
  return Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000);
}

// 季度许可量：年度许可量 × 当季实际天数 / 全年天数
function quarterPermitTons(data, metric, quarter) {
  const settings = data.settings;
  const annual = metric === '氨氮' ? Number(settings.annualPermitAmmoniaTons) : Number(settings.annualPermitCodTons);
  return store.round(annual * store.daysInQuarter(quarter) / daysInYear(Number(String(quarter).slice(0, 4))), 4);
}

// 口径⑥：年累计按许可年（单位台账许可年起始日滚动 12 个月），跨自然年不重置，也不带入其他许可年的数据
function permitYearWindow(plant, settings) {
  const start = String((plant && plant.permitYearStart) || settings.permitYearStart).slice(0, 10);
  const [y, m, d] = start.split('-').map(Number);
  const p = (n) => String(n).padStart(2, '0');
  return {
    start: start + ' 00:00:00',
    end: (y + 1) + '-' + p(m) + '-' + p(d) + ' 00:00:00',
  };
}

function accumulatedTons(data, metric) {
  const settings = data.settings;
  let total = 0;
  for (const outlet of data.outlets) {
    const plant = plantOf(data, outlet.plantId);
    const win = permitYearWindow(plant, settings);
    const rows = readingsOf(data, { outletId: outlet.id, metric, from: win.start, to: win.end });
    total += massOverRows(data, rows, settings) * 1000 / Number(settings.tonsDivisor);
  }
  return store.round(total, 4);
}

// 口径⑦：日平均超限值，或者小时折算浓度超限值达到规定次数及以上，都判定月超标（无效日不参与）
function exceedance(data, outletId, metric, month) {
  const settings = data.settings;
  const series = dailySeries(data, outletId, metric, month);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const exceedDays = series.filter((s) => s.exceed).map((s) => s.day);
  let exceedHours = 0;
  const exceedHourList = [];
  for (const s of series) {
    for (const row of s.rows) {
      if (row.counted && row.concentration > limit) {
        exceedHours += 1;
        exceedHourList.push(row.at);
      }
    }
  }
  const hourlyExceed = exceedHours >= Number(settings.hourlyExceedCountLimit);
  return {
    month,
    outletId,
    metric,
    limit,
    exceedDays,
    exceedDaysCount: exceedDays.length,
    exceedHours,
    exceedHourList,
    hourlyExceed,
    exceeded: exceedDays.length > 0 || hourlyExceed,
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
  MIN_VALID_HOURS_PER_DAY,
  plantOf, outletOf, deviceOf,
  readingsOf, inTimeRange, isCounted, isIncluded, excludedReason, effectiveConcentration, oxygenAt, flowAt, isStopped,
  permitYearWindow, massOverRows, periodTotal,
  dayRows, dailyStats, dailySeries, monthAverage, monthTotal, quarterTotal, quarterPermitTons, accumulatedTons,
  exceedance, outletsOf, outletSummary,
};
