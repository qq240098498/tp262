// 对外提供链路：公开清单、口径说明、脱敏规则、批次记录与二次校验
// 原则：导出的每一批数据都带口径说明与脱敏说明，批次留档（含内容快照与内部对齐映射），
// 同一范围同一规则重导结果一致，且能逐行与内部数据对齐核查。
const crypto = require('crypto');
const { AppError } = require('./errors');
const store = require('./store');
const monitor = require('./monitor');
const { METRICS } = require('./resources');

const CONC_METRICS = ['COD', '氨氮'];

/* ================= 脱敏规则层 ================= */
// 可维护的一层：规则按版本保存、只增不改；每批导出记录所用版本，改动有留痕
const MASK_FIELDS = ['plantCode', 'deviceCode', 'operator', 'remark', 'readingId'];
const MASK_ACTIONS = ['keep', 'alias', 'drop'];
const MASK_FIELD_LABELS = {
  plantCode: '单位内部编号',
  deviceCode: '设备编号',
  operator: '登记人',
  remark: '备注',
  readingId: '数据内部编号',
};
const MASK_ACTION_LABELS = { keep: '原样保留', alias: '替换为别名', drop: '剔除' };
const ALIAS_PREFIX = { plantCode: 'DW', deviceCode: 'SB', readingId: 'SJ' };

// 默认规则：未保存过任何规则时生效；盐值固定，保证别名跨重启稳定
const DEFAULT_MASK_RULE = {
  id: 'mr-0001',
  version: 1,
  createdAt: '',
  createdBy: '系统默认',
  note: '默认规则：内部编号替换为别名、登记人与备注剔除',
  salt: 'default-mask-rule-v1',
  rules: { plantCode: 'alias', deviceCode: 'alias', operator: 'drop', remark: 'drop', readingId: 'alias' },
};

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// 规则只增不改：默认规则（v1）永远在列，其后是保存过的版本
function maskRulesOf(data) {
  return [DEFAULT_MASK_RULE].concat(data.share.maskRules);
}
function currentMaskRule(data) {
  const rules = maskRulesOf(data);
  return rules[rules.length - 1];
}
function maskVersionOf(rule) {
  return 'MR-' + rule.version;
}
function maskRuleByVersion(data, version) {
  return maskRulesOf(data).find((r) => maskVersionOf(r) === version) || null;
}

// 别名：由内部编号按规则盐值单向生成；内部凭规则版本即可重算，与内部数据对齐核查
function aliasFor(rule, field, internalCode) {
  const prefix = ALIAS_PREFIX[field] || 'NB';
  return prefix + '-' + sha256(rule.salt + '|' + field + '|' + String(internalCode)).slice(0, 10).toUpperCase();
}

function maskDescription(rule) {
  const parts = MASK_FIELDS.map((f) => MASK_FIELD_LABELS[f] + MASK_ACTION_LABELS[rule.rules[f]]);
  return '脱敏规则版本 ' + maskVersionOf(rule) + '：' + parts.join('，')
    + '。别名由内部编号按规则盐值单向生成，同一规则版本下同一对象别名固定；'
    + '内部可凭规则版本将别名与内部数据逐条对齐核查（映射留档在批次记录中，不随文件对外）。';
}

function publicMaskRule(rule) {
  return {
    version: rule.version,
    maskVersion: maskVersionOf(rule),
    createdAt: rule.createdAt,
    createdBy: rule.createdBy,
    note: rule.note,
    rules: rule.rules,
    description: maskDescription(rule),
  };
}

/* ================= 口径说明 ================= */
// 口径说明随数据一起对外给出；内容由当前设置生成，设置一变版本号即变，留痕可查
function caliberDoc(settings) {
  return {
    有效数据判定: '同时满足三条才计入统计：数据标记为「有效」；设备状态为「正常」；浓度类指标（COD、氨氮）数值在量程内（'
      + settings.rangeMin + ' 至 ' + settings.rangeMax + '）。设备处于校准、维护、故障状态，或数值超量程、为负数的，按无效处理，不计入平均、总量与超标判定。流量、氧含量作为配对参数，只要求标记有效且设备正常。',
    折算公式: '折算浓度 = 实测浓度 × (21 − 基准氧含量) / (21 − 实测氧含量)，基准氧含量取 ' + settings.oxygenBaseline
      + '；该时刻没有氧含量读数时按基准氧处理（等价于不折算）。折算浓度按两位小数取值，所有平均、总量与超标判定均使用折算后浓度。折算浓度仅对 COD、氨氮给出。',
    日平均与补录: '日均按小时流量加权：日均 = Σ(折算浓度 × 该小时流量) / Σ该小时流量；当日流量合计为 0 时按算术平均计。单日有效小时不足 '
      + monitor.MIN_VALID_HOURS_PER_DAY + ' 小时，或补录小时超过 ' + settings.maxImputeHoursPerDay + ' 小时的，该日不计入平均与总量。',
    总量公式: '每小时排放量(吨) = 折算浓度(mg/L) × 流量(m³/h) × 1000 / ' + settings.tonsDivisor
      + '；月总量按同一时刻的浓度与流量逐小时配对累加，月平均按有效天数平均（分母是有效天数，不是当月天数）；季度总量与年累计用同一公式逐小时累加，不做任何按天外推。',
    超标口径: '日平均超过限值（COD ' + settings.codDailyLimit + '、氨氮 ' + settings.ammoniaDailyLimit
      + '），或小时值超过限值达到 ' + settings.hourlyExceedCountLimit + ' 次及以上，二者满足其一即判定当月超标。',
    不计入情形: '排污单位处于停产状态、或排放口处于停用状态的时段，其小时值不计入平均与总量，也不参与超标判定（数据保留可查）。',
  };
}
function caliberVersionOf(doc) {
  return 'KJ-' + sha256(canonical(doc)).slice(0, 12).toUpperCase();
}

/* ================= 导出范围 ================= */
function normalizeBound(value, isEnd) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text + (isEnd ? ' 23:59:59' : ' 00:00:00');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return text + ':00';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return text;
  return null;
}

function normalizeScope(data, payload) {
  const errors = {};
  const outletIds = Array.isArray(payload.outletIds) ? payload.outletIds.filter(Boolean).map(String) : [];
  if (!outletIds.length) errors.outletIds = '至少要选一个排放口';
  const known = new Set(data.outlets.map((o) => o.id));
  const badOutlet = outletIds.find((id) => !known.has(id));
  if (badOutlet) errors.outletIds = '排放口不存在：' + badOutlet;
  const metrics = Array.isArray(payload.metrics) ? payload.metrics.filter(Boolean).map(String) : [];
  if (!metrics.length) errors.metrics = '至少要选一个指标';
  const badMetric = metrics.find((m) => !METRICS.includes(m));
  if (badMetric) errors.metrics = '监测指标只能是：' + METRICS.join('、') + '（收到：' + badMetric + '）';
  const from = normalizeBound(payload.from, false);
  const to = normalizeBound(payload.to, true);
  if (payload.from && !from) errors.from = '开始时刻要像 2026-09-01 或 2026-09-01 08:00:00';
  if (payload.to && !to) errors.to = '结束时刻要像 2026-09-30 或 2026-09-30 23:00:00';
  if (from && to && from > to) errors.to = '结束时刻不能早于开始时刻';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '导出范围没通过校验', errors);
  return { outletIds, metrics, from, to };
}

/* ================= 导出数据生成 ================= */
// 导出数据与页面同一套口径（monitor 模块）；行内字段顺序固定，保证校验值可复算
function buildExport(data, scope, rule) {
  const wanted = new Set(scope.outletIds);
  const metrics = new Set(scope.metrics);
  const mapping = { plants: {}, devices: {}, readings: {} };
  const list = data.readings
    .filter((r) => wanted.has(r.outletId) && metrics.has(r.metric))
    .filter((r) => (!scope.from || r.at >= scope.from) && (!scope.to || r.at <= scope.to));

  const rows = list.map((r) => {
    const device = monitor.deviceOf(data, r.deviceId);
    const outlet = monitor.outletOf(data, r.outletId);
    const plant = outlet ? monitor.plantOf(data, outlet.plantId) : null;
    const stopped = monitor.isStopped(data, r);
    const counted = !stopped && monitor.isCounted(r, device, data.settings);
    const oxygen = monitor.oxygenAt(data, r);
    const row = {};
    if (rule.rules.readingId !== 'drop') {
      const idAlias = rule.rules.readingId === 'alias' ? aliasFor(rule, 'readingId', r.id) : r.id;
      mapping.readings[r.id] = idAlias;
      row['数据编号'] = idAlias;
    }
    row['排放口'] = outlet ? outlet.code : '';
    row['排放口名称'] = outlet ? outlet.name : '';
    row['所属单位'] = plant ? plant.name : '';
    if (rule.rules.plantCode !== 'drop') {
      const code = plant ? plant.code : '';
      const codeAlias = rule.rules.plantCode === 'alias' ? aliasFor(rule, 'plantCode', code) : code;
      if (code) mapping.plants[code] = codeAlias;
      row['单位编号'] = codeAlias;
    }
    if (rule.rules.deviceCode !== 'drop') {
      const code = device ? device.code : '';
      const codeAlias = rule.rules.deviceCode === 'alias' ? aliasFor(rule, 'deviceCode', code) : code;
      if (code) mapping.devices[code] = codeAlias;
      row['设备'] = codeAlias;
    }
    row['指标'] = r.metric;
    row['时刻'] = r.at;
    row['数值'] = Number(r.value);
    row['标记'] = r.flag;
    row['来源'] = r.source;
    row['是否计入'] = counted;
    row['折算浓度'] = CONC_METRICS.includes(r.metric) ? monitor.effectiveConcentration(data, r, oxygen) : null;
    row['当时氧含量'] = oxygen;
    row['当时流量'] = monitor.flowAt(data, r);
    if (rule.rules.operator !== 'drop') {
      row['登记人'] = rule.rules.operator === 'alias' ? aliasFor(rule, 'operator', r.operator || '未登记') : (r.operator || '');
    }
    if (rule.rules.remark !== 'drop') row['备注'] = r.remark || '';
    return row;
  });

  rows.sort((a, b) => {
    const ka = a['排放口'] + '|' + a['指标'] + '|' + a['时刻'] + '|' + (a['数据编号'] || '');
    const kb = b['排放口'] + '|' + b['指标'] + '|' + b['时刻'] + '|' + (b['数据编号'] || '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return { rows, mapping, rowCount: rows.length, checksum: sha256(canonical(rows)) };
}

/* ================= 公开清单与预览 ================= */
function catalog(data) {
  const rule = currentMaskRule(data);
  const caliber = caliberDoc(data.settings);
  const ats = data.readings.map((r) => r.at).sort();
  return {
    outlets: data.outlets.map((o) => {
      const plant = monitor.plantOf(data, o.plantId);
      return { id: o.id, code: o.code, name: o.name, status: o.status, plantName: plant ? plant.name : '' };
    }),
    metrics: METRICS,
    timeBounds: { min: ats[0] || '', max: ats[ats.length - 1] || '' },
    caliberVersion: caliberVersionOf(caliber),
    caliber,
    maskVersion: maskVersionOf(rule),
    maskRule: publicMaskRule(rule),
    batchCount: data.share.batches.length,
  };
}

function preview(data, payload) {
  const scope = normalizeScope(data, payload);
  const rule = currentMaskRule(data);
  const caliber = caliberDoc(data.settings);
  const built = buildExport(data, scope, rule);
  return {
    scope: {
      outletIds: scope.outletIds,
      outletCodes: scope.outletIds.map((id) => { const o = monitor.outletOf(data, id); return o ? o.code : id; }),
      metrics: scope.metrics,
      from: scope.from,
      to: scope.to,
    },
    rowCount: built.rowCount,
    checksum: built.checksum,
    caliberVersion: caliberVersionOf(caliber),
    maskVersion: maskVersionOf(rule),
  };
}

/* ================= 批次记录 ================= */
function batchMeta(batch) {
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    operator: batch.operator,
    scope: batch.scope,
    caliberVersion: batch.caliberVersion,
    maskVersion: batch.maskVersion,
    rowCount: batch.rowCount,
    checksum: batch.checksum,
  };
}

function listBatches(data) {
  return {
    batches: data.share.batches.map(batchMeta).slice().reverse(),
    caliberLog: data.share.caliberLog.slice().reverse(),
  };
}

function findBatch(data, id) {
  const batch = data.share.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个导出批次不存在');
  return batch;
}

function batchDetail(data, id) {
  const batch = findBatch(data, id);
  return Object.assign(batchMeta(batch), {
    caliberSnapshot: batch.caliberSnapshot,
    maskSnapshot: batch.maskSnapshot,
    maskDescription: batch.content['口径说明']['脱敏说明'],
    mapping: batch.mapping,
  });
}

function createBatch(data, payload) {
  const scope = normalizeScope(data, payload);
  const operator = String(payload.operator || '').trim();
  if (!operator) throw new AppError(400, 'VALIDATION_FAILED', '这次对外提供没通过校验', { operator: '操作人不能为空，批次要落到人' });
  const rule = currentMaskRule(data);
  const caliber = caliberDoc(data.settings);
  const caliberVersion = caliberVersionOf(caliber);
  const built = buildExport(data, scope, rule);
  if (!built.rowCount) {
    throw new AppError(400, 'VALIDATION_FAILED', '这次对外提供没通过校验', { outletIds: '当前范围（排放口 × 指标 × 时段）内没有监测数据' });
  }
  const batch = {
    id: store.nextId('sb', data.share.batches),
    createdAt: store.nowText(),
    operator,
    scope: {
      outletIds: scope.outletIds,
      outletCodes: scope.outletIds.map((id) => { const o = monitor.outletOf(data, id); return o ? o.code : id; }),
      metrics: scope.metrics,
      from: scope.from,
      to: scope.to,
    },
    caliberVersion,
    caliberSnapshot: caliber,
    maskVersion: maskVersionOf(rule),
    maskSnapshot: { rules: rule.rules, note: rule.note },
    rowCount: built.rowCount,
    checksum: built.checksum,
    mapping: built.mapping,
    content: null,
  };
  batch.content = {
    批次信息: {
      批次号: batch.id,
      导出时刻: batch.createdAt,
      操作人: batch.operator,
      范围: {
        排放口: batch.scope.outletCodes,
        指标: batch.scope.metrics,
        开始时刻: scope.from || '不限',
        结束时刻: scope.to || '不限',
      },
      口径版本: caliberVersion,
      脱敏规则版本: batch.maskVersion,
      数据条数: built.rowCount,
      校验值: built.checksum,
    },
    口径说明: Object.assign({}, caliber, { 脱敏说明: maskDescription(rule) }),
    数据: built.rows,
  };
  data.share.batches.push(batch);
  // 口径留痕：本次口径版本第一次出现时登记，事后能查每版口径何时开始对外使用
  if (!data.share.caliberLog.some((c) => c.version === caliberVersion)) {
    data.share.caliberLog.push({ version: caliberVersion, firstUsedAt: batch.createdAt, settings: Object.assign({}, data.settings) });
  }
  return batchMeta(batch);
}

function batchFile(data, id) {
  const batch = findBatch(data, id);
  const ascii = 'share-' + batch.id + '.json';
  const chinese = '对外提供_' + batch.id + '_' + batch.createdAt.replace(/[-: ]/g, '') + '.json';
  return {
    __headers: { 'Content-Disposition': "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(chinese) },
    __body: batch.content,
  };
}

/* ================= 二次校验 ================= */
// 两件事：一、按批次冻结的范围与规则版本重新生成，结果应与批次一致（同一批数据导出两次结果一致）；
// 二、把批次的每一行按映射找回内部数据逐字段核对（与内部口径核对能对上）
function verifyBatch(data, id) {
  const batch = findBatch(data, id);
  const rule = maskRuleByVersion(data, batch.maskVersion);
  if (!rule) throw new AppError(409, 'MASK_RULE_MISSING', '批次使用的脱敏规则版本找不到了：' + batch.maskVersion);
  const scope = {
    outletIds: batch.scope.outletIds,
    metrics: batch.scope.metrics,
    from: batch.scope.from,
    to: batch.scope.to,
  };
  const rebuilt = buildExport(data, scope, rule);
  const consistent = rebuilt.rowCount === batch.rowCount && rebuilt.checksum === batch.checksum;

  // 对齐核查：优先按数据编号映射找回，编号被剔除的批次退化为按 排放口|指标|时刻 找回
  const readingById = new Map(data.readings.map((r) => [r.id, r]));
  const readingByKey = new Map();
  for (const r of data.readings) {
    const outlet = monitor.outletOf(data, r.outletId);
    if (outlet) readingByKey.set(outlet.code + '|' + r.metric + '|' + r.at, r);
  }
  const aliasToId = {};
  for (const internalId of Object.keys(batch.mapping.readings || {})) {
    aliasToId[batch.mapping.readings[internalId]] = internalId;
  }
  const alignment = { total: batch.content['数据'].length, aligned: 0, missing: 0, drifted: [] };
  for (const row of batch.content['数据']) {
    let internal = null;
    if (row['数据编号'] !== undefined) {
      const internalId = batch.maskSnapshot.rules.readingId === 'alias' ? aliasToId[row['数据编号']] : row['数据编号'];
      internal = readingById.get(internalId) || null;
    } else {
      internal = readingByKey.get(row['排放口'] + '|' + row['指标'] + '|' + row['时刻']) || null;
    }
    if (!internal) {
      alignment.missing += 1;
      if (alignment.drifted.length < 20) alignment.drifted.push({ 行: row['数据编号'] || (row['排放口'] + ' ' + row['指标'] + ' ' + row['时刻']), 问题: '内部数据里找不到了' });
      continue;
    }
    const device = monitor.deviceOf(data, internal.deviceId);
    const stopped = monitor.isStopped(data, internal);
    const nowCounted = !stopped && monitor.isCounted(internal, device, data.settings);
    const nowConc = CONC_METRICS.includes(internal.metric) ? monitor.effectiveConcentration(data, internal) : null;
    const diffs = [];
    if (Number(internal.value) !== row['数值']) diffs.push('数值 导出 ' + row['数值'] + ' ≠ 当前 ' + internal.value);
    if (internal.flag !== row['标记']) diffs.push('标记 导出 ' + row['标记'] + ' ≠ 当前 ' + internal.flag);
    if (internal.source !== row['来源']) diffs.push('来源 导出 ' + row['来源'] + ' ≠ 当前 ' + internal.source);
    if (nowCounted !== row['是否计入']) diffs.push('是否计入 导出 ' + row['是否计入'] + ' ≠ 当前 ' + nowCounted);
    if (nowConc !== row['折算浓度']) diffs.push('折算浓度 导出 ' + row['折算浓度'] + ' ≠ 当前 ' + nowConc);
    if (diffs.length) {
      if (alignment.drifted.length < 20) alignment.drifted.push({ 行: row['数据编号'] || internal.id, 问题: diffs.join('；') });
    } else {
      alignment.aligned += 1;
    }
  }

  const caliberNow = caliberVersionOf(caliberDoc(data.settings));
  return {
    batchId: batch.id,
    verifiedAt: store.nowText(),
    consistent,
    rowCount: batch.rowCount,
    checksum: batch.checksum,
    rowCountNow: rebuilt.rowCount,
    checksumNow: rebuilt.checksum,
    caliberVersion: batch.caliberVersion,
    caliberVersionNow: caliberNow,
    caliberChanged: caliberNow !== batch.caliberVersion,
    maskVersion: batch.maskVersion,
    maskVersionNow: maskVersionOf(currentMaskRule(data)),
    alignment,
  };
}

/* ================= 脱敏规则维护 ================= */
function listMaskRules(data) {
  const usedBy = {};
  for (const b of data.share.batches) usedBy[b.maskVersion] = (usedBy[b.maskVersion] || 0) + 1;
  return {
    current: maskVersionOf(currentMaskRule(data)),
    rules: maskRulesOf(data).map((r) => Object.assign(publicMaskRule(r), { batchCount: usedBy[maskVersionOf(r)] || 0 })).slice().reverse(),
    fields: MASK_FIELDS.map((f) => ({ field: f, label: MASK_FIELD_LABELS[f] })),
    actions: MASK_ACTIONS.map((a) => ({ action: a, label: MASK_ACTION_LABELS[a] })),
  };
}

function createMaskRule(data, payload) {
  const rules = payload.rules || {};
  const errors = {};
  for (const f of MASK_FIELDS) {
    if (!MASK_ACTIONS.includes(rules[f])) {
      errors[f] = MASK_FIELD_LABELS[f] + '的处理方式只能是：' + MASK_ACTIONS.map((a) => MASK_ACTION_LABELS[a] + '(' + a + ')').join('、');
    }
  }
  const unknown = Object.keys(rules).filter((k) => !MASK_FIELDS.includes(k));
  if (unknown.length) errors.rules = '不认识的字段：' + unknown.join('、');
  const createdBy = String(payload.createdBy || '').trim();
  if (!createdBy) errors.createdBy = '操作人不能为空，规则改动要留痕到人';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '脱敏规则没通过校验', errors);
  const current = currentMaskRule(data);
  const rule = {
    id: store.nextId('mr', maskRulesOf(data)),
    version: current.version + 1,
    createdAt: store.nowText(),
    createdBy,
    note: String(payload.note || '').trim(),
    salt: crypto.randomBytes(8).toString('hex'),
    rules: MASK_FIELDS.reduce((acc, f) => { acc[f] = rules[f]; return acc; }, {}),
  };
  data.share.maskRules.push(rule);
  return publicMaskRule(rule);
}

module.exports = {
  catalog, preview, createBatch, listBatches, batchDetail, batchFile, verifyBatch,
  listMaskRules, createMaskRule,
  caliberDoc, caliberVersionOf, maskDescription,
  MASK_FIELDS, MASK_ACTIONS, MASK_FIELD_LABELS, MASK_ACTION_LABELS,
};
