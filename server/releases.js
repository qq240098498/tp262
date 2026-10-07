// 对外提供链路：公开清单选择 → 口径/脱敏预览 → 生成批次（清单+口径+脱敏规则随包落盘）
// → 二次下载一致性校验 → 按批次 salt 与历史版本复算 → 别名与内部数据对齐核查。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AppError } = require('./errors');
const store = require('./store');
const monitor = require('./monitor');
const caliber = require('./caliber');
const masking = require('./masking');

const SELECTABLE_METRICS = ['COD', '氨氮', '流量', '氧含量'];
const POLLUTANT_METRICS = ['COD', '氨氮'];
const RELEASE_DIR = path.join(__dirname, '..', 'data', 'releases');
const PREVIEW_ROWS = 5;

function sha256(textOrBuffer) {
  return crypto.createHash('sha256').update(textOrBuffer).digest('hex');
}

function ensureReleaseDir() {
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
}

// 没有改过脱敏规则时，第一次用规则的地方补登 msr-0000（系统默认版本）
function ensureDefaultMasking(data) {
  if (!Array.isArray(data.maskingRules)) data.maskingRules = [];
  if (!data.maskingRules.length) {
    data.maskingRules.push({
      version: 'msr-0000',
      createdAt: store.nowText(),
      createdBy: '',
      note: '系统默认规则（首次对外提供时定格）',
      basedOn: '',
      fields: masking.defaultRules(),
    });
  }
  return masking.currentVersion(data);
}

function validateScope(data, payload) {
  const errors = {};
  const metrics = Array.isArray(payload.metrics) ? payload.metrics : [];
  if (!metrics.length) errors.metrics = '至少选择一个公开指标';
  else if (metrics.some((m) => !SELECTABLE_METRICS.includes(m))) errors.metrics = '指标只能是：' + SELECTABLE_METRICS.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(String(payload.from || ''))) errors.from = '起始时刻要像 2026-09-01 00:00:00';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(String(payload.to || ''))) errors.to = '截止时刻要像 2026-09-30 23:00:00';
  if (!errors.from && !errors.to && String(payload.from) > String(payload.to)) errors.to = '截止时刻不能早于起始时刻';
  let outletIds = [];
  if (Array.isArray(payload.outletIds) && payload.outletIds.length) {
    outletIds = payload.outletIds.slice();
    for (const id of outletIds) {
      if (!data.outlets.some((o) => o.id === id)) errors.outletIds = '排放口不存在：' + id;
    }
  }
  if (!String(payload.recipient || '').trim()) errors.recipient = '接收方不能为空（园区 / 社区 / 上级平台）';
  if (!String(payload.operator || '').trim()) errors.operator = '操作人不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'RELEASE_SCOPE_INVALID', '公开清单没通过校验', errors);
  const norm = (t) => (String(t).length === 16 ? String(t) + ':00' : String(t));
  return {
    metrics: Array.from(new Set(metrics)),
    from: norm(payload.from),
    to: norm(payload.to),
    outletIds,
    recipient: String(payload.recipient).trim(),
    purpose: String(payload.purpose || '').trim(),
    operator: String(payload.operator).trim(),
  };
}

function scopedOutlets(data, outletIds) {
  if (outletIds.length) return data.outlets.filter((o) => outletIds.includes(o.id));
  return data.outlets.slice();
}

function scopedReadings(data, scope) {
  return monitor.readingsOf(data, { metrics: scope.metrics, from: scope.from, to: scope.to })
    .filter((r) => !scope.outletIds.length || scope.outletIds.includes(r.outletId));
}

// 用指定口径参数与脱敏规则（而不是当前 settings / 当前规则）构建整包——创建与复算共用，保证字节级可复现
function buildPackage(data, opts) {
  const scope = opts.scope;
  const params = opts.params;             // 定格的口径参数
  const ruleVersion = opts.ruleVersion;   // 定格的脱敏规则版本
  const salt = opts.salt;                 // 批次 salt（只存在内部对照文件里）
  const frozenData = Object.assign({}, data, { settings: Object.assign({}, data.settings, params) });
  const settings = frozenData.settings;

  const outlets = scopedOutlets(data, scope.outletIds).sort((a, b) => (a.code < b.code ? -1 : 1));
  const outletIdSet = new Set(outlets.map((o) => o.id));
  const plants = data.plants.filter((p) => outlets.some((o) => o.plantId === p.id));
  const devices = data.devices.filter((d) => outletIdSet.has(d.outletId));
  const readings = scopedReadings(data, scope)
    .filter((r) => outletIdSet.has(r.outletId) && devices.some((d) => d.id === r.deviceId));

  const mask = masking.session(ruleVersion, salt);
  // 关联实体（单位/排放口/设备）的别名只派生一次，数据行复用，保证整包内别名一致可关联
  const aliases = {
    plant: {}, outlet: {}, device: {}, operator: {},
  };
  const aliasOf = (kind, entityName, id, prefix) => {
    if (!aliases[kind][id]) {
      aliases[kind][id] = mask.apply(entityName, 'id', id).value;
    }
    return aliases[kind][id];
  };

  const units = plants.map((p) => ({
    unitAlias: aliasOf('plant', 'plant', p.id, 'ENT'),
    name: mask.apply('plant', 'name', p.name).value,
    permitNo: mask.apply('plant', 'permitNo', p.permitNo).value,
    industry: mask.apply('plant', 'industry', p.industry).value,
  })).sort((a, b) => (a.unitAlias < b.unitAlias ? -1 : 1));

  const outletRows = outlets.map((o) => ({
    outletAlias: aliasOf('outlet', 'outlet', o.id, 'OUT'),
    unitAlias: aliasOf('plant', 'plant', o.plantId, 'ENT'),
    outletCode: mask.apply('outlet', 'code', o.code).value,
    outletName: mask.apply('outlet', 'name', o.name).value,
    outletType: mask.apply('outlet', 'type', o.type).value,
  })).sort((a, b) => (a.outletAlias < b.outletAlias ? -1 : 1));

  const deviceRows = devices.map((d) => ({
    deviceAlias: aliasOf('device', 'device', d.id, 'DEV'),
    outletAlias: aliasOf('outlet', 'outlet', d.outletId, 'OUT'),
    deviceCodeAlias: mask.apply('device', 'code', d.code).value,
    model: mask.apply('device', 'model', d.model).value,
    metric: mask.apply('device', 'metric', d.metric).value,
    status: mask.apply('device', 'status', d.status).value,
    calibratedUntil: mask.apply('device', 'calibratedUntil', d.calibratedUntil).value,
  })).sort((a, b) => (a.deviceAlias < b.deviceAlias ? -1 : 1));

  const operatorRule = (ruleVersion.fields || []).find((f) => f.entity === 'reading' && f.field === 'operator') || { action: 'hash' };
  const operatorAlias = (name) => {
    if (operatorRule.action === 'drop') return undefined; // 整列剔除：数据包里不出现该列
    const key = String(name || '');
    if (!key) return '';
    if (!aliases.operator[key]) aliases.operator[key] = mask.apply('reading', 'operator', key).value;
    return aliases.operator[key];
  };

  const rows = readings.map((r) => {
    const included = monitor.isIncluded(frozenData, r);
    const oxygen = monitor.oxygenAt(data, r);
    const isPollutant = POLLUTANT_METRICS.includes(r.metric);
    return {
      releaseNo: opts.releaseNo,
      readingAlias: mask.apply('reading', 'id', r.id).value,
      outletAlias: aliasOf('outlet', 'outlet', r.outletId, 'OUT'),
      deviceAlias: aliasOf('device', 'device', r.deviceId, 'DEV'),
      metric: r.metric,
      at: r.at,
      measuredValue: Number(r.value),
      oxygen: oxygen == null ? '' : oxygen,
      flow: monitor.flowAt(data, r),
      concentration: included && isPollutant ? monitor.effectiveConcentration(r, settings, oxygen) : '',
      flag: r.flag,
      source: r.source,
      counted: included,
      excludedReason: included ? '' : monitor.excludedReason(frozenData, r),
      operatorAlias: operatorAlias(r.operator),
    };
  }).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.outletAlias < b.outletAlias ? -1 : a.outletAlias > b.outletAlias ? 1 : a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : a.readingAlias < b.readingAlias ? -1 : 1));

  // 日明细与时段总量：只用被选中的污染指标，且按定格口径计算（frozenData）
  const outletIdByAlias = {};
  outletRows.forEach((row) => {
    const o = outlets.find((x) => aliasOf('outlet', 'outlet', x.id, 'OUT') === row.outletAlias);
    if (o) outletIdByAlias[row.outletAlias] = o.id;
  });
  const daySet = {};
  for (const r of readings) {
    if (POLLUTANT_METRICS.includes(r.metric)) daySet[r.outletId + '|' + r.metric + '|' + store.dayOf(r.at)] = true;
  }
  const daily = Object.keys(daySet).sort().map((key) => {
    const [outletId, metric, day] = key.split('|');
    const stat = monitor.dailyStats(frozenData, outletId, metric, day);
    return {
      outletAlias: aliasOf('outlet', 'outlet', outletId, 'OUT'),
      metric,
      day,
      countedHours: stat.countedHours,
      imputedHours: stat.imputedHours,
      dailyAverage: stat.average,
      valid: stat.valid,
      reason: stat.reason,
      limit: stat.limit,
      exceed: stat.exceed,
      flowTotal: stat.flowTotal,
    };
  });
  const totals = [];
  for (const outlet of outlets) {
    for (const metric of scope.metrics.filter((m) => POLLUTANT_METRICS.includes(m))) {
      totals.push({
        outletAlias: aliasOf('outlet', 'outlet', outlet.id, 'OUT'),
        metric,
        from: scope.from,
        to: scope.to,
        totalTons: monitor.periodTotal(frozenData, outlet.id, metric, scope.from, scope.to),
      });
    }
  }

  const calSnap = {
    version: opts.caliberVersion,
    fingerprint: opts.caliberFingerprint,
    params,
    statements: caliber.statements(params),
  };
  const maskView = masking.publicRuleView(ruleVersion);

  const manifest = {
    releaseNo: opts.releaseNo,
    createdAt: opts.createdAt,
    operator: scope.operator,
    recipient: scope.recipient,
    purpose: scope.purpose,
    scope: {
      metrics: scope.metrics.slice(),
      from: scope.from,
      to: scope.to,
      outlets: outlets.map((o) => ({ code: o.code, name: o.name, type: o.type, plantName: (monitor.plantOf(data, o.plantId) || {}).name || '' })),
    },
    caliberVersion: calSnap.version,
    caliberFingerprint: calSnap.fingerprint,
    maskingVersion: maskView.version,
    rowCount: rows.length,
    countedRowCount: rows.filter((r) => r.counted).length,
    excludedRowCount: rows.filter((r) => !r.counted).length,
    files: ['release-package.json（本说明与全部数据）', 'data.csv（同一份数据的表格版）', '口径说明.txt（口径文字版）'],
    note: '本包为对外提供数据，内部编号与人员信息已按 maskingVersion 对应规则替换或剔除；别名与内部数据的对照表仅留存于单位内部，不在本包内。',
  };

  const pkg = { manifest, caliber: calSnap, maskingRules: maskView, units, outlets: outletRows, devices: deviceRows, rows, daily, totals };
  return { package: pkg, alignMap: mask.alignMap, stats: mask.stats };
}

const CSV_COLUMNS = [
  ['releaseNo', '批次号'], ['readingAlias', '数据记录别名'], ['outletAlias', '排放口别名'], ['deviceAlias', '设备别名'],
  ['metric', '指标'], ['at', '时刻'], ['measuredValue', '实测值'], ['oxygen', '实测氧含量'], ['flow', '实测流量'],
  ['concentration', '折算浓度'], ['flag', '标记'], ['source', '来源'], ['counted', '是否计入'],
  ['excludedReason', '不计入原因'], ['operatorAlias', '登记人别名'],
];

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(pkg) {
  let columns = CSV_COLUMNS.slice();
  // 规则为「整列剔除」的列不出现在表格里（如登记人被 drop 时）
  if (!pkg.rows.some((r) => r.operatorAlias !== undefined)) columns = columns.filter((c) => c[0] !== 'operatorAlias');
  const lines = [columns.map((c) => csvEscape(c[1])).join(',')];
  for (const r of pkg.rows) lines.push(columns.map((c) => csvEscape(r[c[0]])).join(','));
  return lines.join('\r\n') + '\r\n';
}

function caliberText(pkg) {
  const m = pkg.manifest;
  const lines = [];
  lines.push('对外监测数据提供 · 口径说明');
  lines.push('批次号：' + m.releaseNo);
  lines.push('生成时刻：' + m.createdAt + '    操作人：' + m.operator);
  lines.push('接收方：' + m.recipient + (m.purpose ? '    用途：' + m.purpose : ''));
  lines.push('范围：指标 ' + m.scope.metrics.join('、') + '；时段 ' + m.scope.from + ' 至 ' + m.scope.to);
  lines.push('排放口：' + m.scope.outlets.map((o) => o.code + ' ' + o.name).join('；'));
  lines.push('口径版本：' + m.caliberVersion + '（参数指纹 ' + m.caliberFingerprint + '）    脱敏规则版本：' + m.maskingVersion);
  lines.push('数据条数：' + m.rowCount + '（计入 ' + m.countedRowCount + '，不计入 ' + m.excludedRowCount + '）');
  lines.push('');
  pkg.caliber.statements.forEach((s, i) => {
    lines.push((i + 1) + '. 【' + s.title + '】');
    lines.push('   ' + s.text);
    lines.push('');
  });
  lines.push('【脱敏口径】');
  lines.push('内部编号与人员信息按「' + m.maskingVersion + '」版规则替换或剔除：替换值由批次内随机盐值对原值做 HMAC-SHA256 派生，');
  lines.push('同一批内同一原值别名稳定、可与内部数据逐表对齐；跨批盐值不同，无法跨批关联到具体内部编号或人员。');
  lines.push('别名对照表与盐值仅保存在提供方内部，不在本数据包内。字段规则详见 maskingRules 一节。');
  return lines.join('\n');
}

function nextReleaseNo(data, atText) {
  const day = String(atText).slice(0, 10).replace(/-/g, '');
  const prefix = 'rel-' + day + '-';
  let max = 0;
  for (const b of data.releaseBatches || []) {
    const m = String(b.releaseNo || '').match(/^rel-\d{8}-(\d+)$/);
    if (m && String(b.releaseNo).indexOf(prefix) === 0) max = Math.max(max, Number(m[1]));
  }
  return prefix + String(max + 1).padStart(4, '0');
}

function preview(data, payload) {
  const scope = validateScope(data, payload);
  const cal = caliber.previewSnapshot(data);
  const ruleVersion = ensureDefaultMasking(data);
  const readings = scopedReadings(data, scope);
  const outlets = scopedOutlets(data, scope.outletIds);
  const deviceSet = new Set();
  readings.forEach((r) => deviceSet.add(r.deviceId));
  const validReadings = readings.filter((r) => monitor.isIncluded(data, r));

  // 示例别名用一次性 salt，预览页明确标注「示例」，与正式批次别名无关
  const sampleSalt = crypto.randomBytes(16).toString('hex');
  const sampleMask = masking.session(ruleVersion, sampleSalt);
  const samples = readings.slice(0, PREVIEW_ROWS).map((r) => ({
    at: r.at, outletCode: (monitor.outletOf(data, r.outletId) || {}).code || '', metric: r.metric,
    measuredValue: r.value, counted: monitor.isIncluded(data, r),
    excludedReason: monitor.isIncluded(data, r) ? '' : monitor.excludedReason(data, r),
    readingAlias: sampleMask.apply('reading', 'id', r.id).value,
    deviceAlias: sampleMask.apply('reading', 'deviceId', r.deviceId).value,
  }));

  return {
    scope,
    caliber: cal,
    maskingRules: masking.publicRuleView(ruleVersion),
    matched: {
      outletCount: outlets.length,
      outlets: outlets.map((o) => ({ code: o.code, name: o.name, type: o.type, plantName: (monitor.plantOf(data, o.plantId) || {}).name || '' })),
      deviceCount: deviceSet.size,
      rowCount: readings.length,
      countedRowCount: validReadings.length,
      excludedRowCount: readings.length - validReadings.length,
      metricRows: scope.metrics.map((m) => ({ metric: m, count: readings.filter((r) => r.metric === m).length })),
    },
    sampleRows: samples,
    sampleNote: '示例别名由一次性预览盐值派生，与正式批次无关；正式批次生成时另行定格。',
  };
}

function createRelease(data, payload) {
  const scope = validateScope(data, payload);
  ensureDefaultMasking(data);
  const now = store.nowText();
  const releaseNo = nextReleaseNo(data, now);
  const calSnap = caliber.currentSnapshot(data); // 参数没变就复用旧版本号，变了就登记新版本
  const ruleVersion = masking.currentVersion(data);
  const salt = crypto.randomBytes(16).toString('hex');

  const built = buildPackage(data, {
    scope, params: calSnap.params, ruleVersion, salt,
    releaseNo, caliberVersion: calSnap.version, caliberFingerprint: calSnap.fingerprint, createdAt: now,
  });
  const pkg = built.package;

  const packageJson = JSON.stringify(pkg, null, 2);
  const csvText = toCsv(pkg);
  const noteText = caliberText(pkg);
  const csvBuffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csvText, 'utf8')]);
  const noteBuffer = Buffer.from(noteText, 'utf8');
  const packageBuffer = Buffer.from(packageJson, 'utf8');

  const dir = path.join(RELEASE_DIR, releaseNo);
  ensureReleaseDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'release-package.json'), packageBuffer);
  fs.writeFileSync(path.join(dir, 'data.csv'), csvBuffer);
  fs.writeFileSync(path.join(dir, '口径说明.txt'), noteBuffer);

  const packageSha = sha256(packageBuffer);
  const csvSha = sha256(csvBuffer);
  const internalManifest = {
    releaseNo, createdAt: now, operator: scope.operator,
    note: '内部留存，切勿随包对外提供：salt 决定全部别名，align 是别名到内部原值的对照表',
    salt,
    scope,
    align: built.alignMap,
    checksums: { 'release-package.json': packageSha, 'data.csv': csvSha },
  };
  const internalBuffer = Buffer.from(JSON.stringify(internalManifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'internal-align.json'), internalBuffer);
  const internalSha = sha256(internalBuffer);

  if (!Array.isArray(data.releaseBatches)) data.releaseBatches = [];
  const batch = {
    releaseNo,
    createdAt: now,
    operator: scope.operator,
    recipient: scope.recipient,
    purpose: scope.purpose,
    scope: pkg.manifest.scope,
    caliberVersion: calSnap.version,
    caliberFingerprint: calSnap.fingerprint,
    maskingVersion: ruleVersion.version,
    rowCount: pkg.manifest.rowCount,
    countedRowCount: pkg.manifest.countedRowCount,
    excludedRowCount: pkg.manifest.excludedRowCount,
    packageSha256: packageSha,
    csvSha256: csvSha,
    internalSha256: internalSha,
    packageBytes: packageBuffer.length,
    files: ['release-package.json', 'data.csv', '口径说明.txt', 'internal-align.json（内部留存）'],
  };
  data.releaseBatches.push(batch);
  return { batch, package: pkg };
}

function listBatches(data, query) {
  const q = query || {};
  let rows = (data.releaseBatches || []).slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (q.recipient) rows = rows.filter((b) => b.recipient.indexOf(String(q.recipient)) >= 0);
  return rows;
}

function getBatch(data, releaseNo) {
  const batch = (data.releaseBatches || []).find((b) => b.releaseNo === releaseNo);
  if (!batch) throw new AppError(404, 'RELEASE_NOT_FOUND', '这个对外提供批次不存在：' + releaseNo);
  return batch;
}

function batchDir(batch) {
  if (!/^rel-\d{8}-\d{4}$/.test(batch.releaseNo)) throw new AppError(400, 'RELEASE_NO_INVALID', '批次号格式不对');
  return path.join(RELEASE_DIR, batch.releaseNo);
}

function readPackageFile(batch) {
  const file = path.join(batchDir(batch), 'release-package.json');
  if (!fs.existsSync(file)) throw new AppError(410, 'RELEASE_FILE_MISSING', '批次数据包文件已不在 data/releases 目录：' + batch.releaseNo);
  return fs.readFileSync(file);
}

// 二次校验：① 落盘包与批次记录的校验值是否一致（导出两次字节一致）② 用定格口径/规则/salt 对当前内部数据复算是否一致
function verify(data, releaseNo) {
  const batch = getBatch(data, releaseNo);
  const dir = batchDir(batch);
  const result = { releaseNo, checkedAt: store.nowText(), fileIntegrity: {}, rederived: {}, aligned: false };

  const packageFile = path.join(dir, 'release-package.json');
  const csvFile = path.join(dir, 'data.csv');
  const internalFile = path.join(dir, 'internal-align.json');
  const check = (file, expect) => {
    if (!fs.existsSync(file)) return { exists: false, ok: false, expected: expect, actual: '' };
    const actual = sha256(fs.readFileSync(file));
    return { exists: true, ok: actual === expect, expected: expect, actual };
  };
  result.fileIntegrity.package = check(packageFile, batch.packageSha256);
  result.fileIntegrity.csv = check(csvFile, batch.csvSha256);
  result.fileIntegrity.internal = check(internalFile, batch.internalSha256);
  result.fileIntegrity.ok = ['package', 'csv', 'internal'].every((k) => result.fileIntegrity[k].ok);

  let internal = null;
  if (result.fileIntegrity.internal.exists) internal = JSON.parse(fs.readFileSync(internalFile, 'utf8'));
  const calVersion = (data.caliberVersions || []).find((v) => v.version === batch.caliberVersion);
  const ruleVersion = masking.getVersion(data, batch.maskingVersion);
  if (!internal || !calVersion || !ruleVersion) {
    result.rederived.ok = false;
    result.rederived.reason = !internal ? '内部对照文件缺失，无法复算' : !calVersion ? '口径版本已不存在' : '脱敏规则版本已不存在';
    return result;
  }

  const rebuilt = buildPackage(data, {
    scope: internal.scope,
    params: calVersion.params,
    ruleVersion,
    salt: internal.salt,
    releaseNo: batch.releaseNo,
    caliberVersion: batch.caliberVersion,
    caliberFingerprint: batch.caliberFingerprint,
    createdAt: batch.createdAt,
  });
  const rebuiltBuffer = Buffer.from(JSON.stringify(rebuilt.package, null, 2), 'utf8');
  const rebuiltSha = sha256(rebuiltBuffer);
  result.rederived.sha256 = rebuiltSha;
  result.rederived.ok = rebuiltSha === batch.packageSha256;

  // 不一致时定位差异：按数据记录别名比对（新增 / 删除 / 变化），并还原出内部记录号方便核查
  if (!result.rederived.ok) {
    const oldPkg = JSON.parse(readPackageFile(batch).toString('utf8'));
    const oldRows = {};
    oldPkg.rows.forEach((r) => { oldRows[r.readingAlias] = r; });
    const newRows = {};
    rebuilt.package.rows.forEach((r) => { newRows[r.readingAlias] = r; });
    const aliasToId = {};
    Object.keys(internal.align['reading.id'] || {}).forEach((id) => { aliasToId[internal.align['reading.id'][id]] = id; });
    const added = [], deleted = [], changed = [];
    for (const alias of Object.keys(newRows)) {
      if (!oldRows[alias]) added.push({ readingAlias: alias, internalId: aliasToId[alias] || '(新记录)' });
      else if (JSON.stringify(oldRows[alias]) !== JSON.stringify(newRows[alias])) changed.push({ readingAlias: alias, internalId: aliasToId[alias] || '' });
    }
    for (const alias of Object.keys(oldRows)) if (!newRows[alias]) deleted.push({ readingAlias: alias, internalId: aliasToId[alias] || '' });
    result.rederived.diff = {
      addedCount: added.length, deletedCount: deleted.length, changedCount: changed.length,
      added: added.slice(0, 20), deleted: deleted.slice(0, 20), changed: changed.slice(0, 20),
    };
  }
  result.aligned = result.fileIntegrity.ok && result.rederived.ok;
  return result;
}

// 别名反查：外单位拿着数据包里的别名来核对时，从内部对照文件查回原值（不导出整张对照表）
function alignLookup(data, releaseNo, aliases) {
  const batch = getBatch(data, releaseNo);
  const file = path.join(batchDir(batch), 'internal-align.json');
  if (!fs.existsSync(file)) throw new AppError(410, 'RELEASE_FILE_MISSING', '内部对照文件已缺失，无法对齐');
  const internal = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(aliases) ? aliases : [];
  return {
    releaseNo,
    note: '仅供内部核查：以下为别名与内部原值的对应关系，请勿对外提供',
    results: list.map((alias) => ({ alias, matches: masking.lookupAlias(internal.align, String(alias)) })),
  };
}

function packageDetail(data, releaseNo) {
  const batch = getBatch(data, releaseNo);
  const pkg = JSON.parse(readPackageFile(batch).toString('utf8'));
  return { batch, manifest: pkg.manifest, caliber: pkg.caliber, maskingRules: pkg.maskingRules,
    counts: { units: pkg.units.length, outlets: pkg.outlets.length, devices: pkg.devices.length, daily: pkg.daily.length, totals: pkg.totals.length },
    firstRows: pkg.rows.slice(0, 3) };
}

module.exports = {
  SELECTABLE_METRICS, RELEASE_DIR,
  preview, createRelease, listBatches, getBatch, packageDetail, batchDir, verify, alignLookup,
  buildPackage, toCsv, caliberText,
};
