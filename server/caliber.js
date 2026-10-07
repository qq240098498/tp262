// 口径版本：把某次计算/导出所用的统计口径从当前 settings 中「定格」成不可变快照。
// 批次记录里只存版本号与快照本体；以后 settings 再怎么改，历史批次的口径都能原样回看、原样复算。
const crypto = require('crypto');
const store = require('./store');
const monitor = require('./monitor');

const CALIBER_PREFIX = 'cal';

// 口径涉及的全部参数——只有这里列出的 settings 字段变化才会产生新版本
const CALIBER_PARAM_KEYS = [
  'oxygenBaseline', 'rangeMin', 'rangeMax', 'maxImputeHoursPerDay', 'flowWeighted',
  'hourlyExceedCountLimit', 'codDailyLimit', 'ammoniaDailyLimit',
  'annualPermitCodTons', 'annualPermitAmmoniaTons', 'tonsDivisor', 'permitYearStart',
];

function paramSnapshot(settings) {
  const out = {};
  for (const key of CALIBER_PARAM_KEYS) out[key] = settings[key];
  out.minValidHoursPerDay = monitor.MIN_VALID_HOURS_PER_DAY; // 写死在口径里的 18 小时也定格
  out.litersPerCubicMeter = 1000;
  return out;
}

// 给参数快照一个稳定短指纹：参数完全一致 → 指纹一致（同一天内沿用同一版本号）
function fingerprint(params) {
  return crypto.createHash('sha256').update(JSON.stringify(params), 'utf8').digest('hex').slice(0, 12);
}

// 随数据一起给出去的口径说明：每条都写明判定规则与公式，参数取快照值（不是当前值）
function statements(params) {
  const p = params;
  return [
    {
      key: 'validHourly',
      title: '有效数据判定',
      text: '小时值同时满足以下三条才计入统计：① 数据标记为「有效」；② 监测设备状态为「正常」（校准、维护、故障期间的数据不计入）；'
        + '③ 数值合理：COD、氨氮等浓度指标在量程 ' + p.rangeMin + '～' + p.rangeMax + ' 之内，流量、氧含量等辅助量为非负有限值（负数与异常值不计入）。'
        + '此外，排污单位停产或排放口停用时段的数据保留可查但不计入。不满足的记录在数据文件中以 counted=false 给出并注明 excludedReason。',
    },
    {
      key: 'imputation',
      title: '补录数据判定',
      text: '来源标记为「补录」的小时值与自动数据分列标注；单日补录小时超过 ' + p.maxImputeHoursPerDay
        + ' 小时的，该日整体不计入平均与总量，补录值不作为真实监测结果使用。',
    },
    {
      key: 'conversion',
      title: '折算公式',
      text: '折算浓度 = 实测浓度 × (21 − ' + p.oxygenBaseline + ') / (21 − 实测氧含量)；该时刻没有氧含量读数时按基准氧 '
        + p.oxygenBaseline + ' 处理（等价于不折算）。所有平均、总量与超标判定一律使用折算后浓度。',
    },
    {
      key: 'dailyAverage',
      title: '日平均口径',
      text: (p.flowWeighted === false
        ? '日平均按有效小时折算浓度算术平均；'
        : '日平均按小时流量加权：日均 = Σ(折算浓度 × 该小时流量) / Σ该小时流量；')
        + '单日有效小时不足 ' + p.minValidHoursPerDay + ' 小时、或补录小时超过 ' + p.maxImputeHoursPerDay
        + ' 小时的，该日不计入平均与总量。',
    },
    {
      key: 'monthlyAverage',
      title: '月平均口径',
      text: '月平均 = 有效日的日平均之和 / 有效天数，分母是有效天数，不是当月自然天数。',
    },
    {
      key: 'total',
      title: '总量公式',
      text: '每小时排放量(吨) = 折算浓度(mg/L) × 流量(m³/h) × ' + p.litersPerCubicMeter
        + '(升/立方米) ÷ ' + Number(p.tonsDivisor).toLocaleString('en-US')
        + '；月/季/时段总量均逐小时累加，且浓度与流量必须取同一时刻的一对读数，缺失配对的该小时不计总量，不做任何按天外推。',
    },
    {
      key: 'permit',
      title: '季度与许可年口径',
      text: '季度总量为季度内逐小时累加之和；季度许可量 = 年许可量 × 当季实际天数 ÷ 全年天数。'
        + '年累计按许可年起始日 ' + p.permitYearStart + ' 起算的 12 个月滚动窗口，跨自然年不重置，也不带入其他许可年的数据。'
        + '年许可量：COD ' + p.annualPermitCodTons + ' 吨、氨氮 ' + p.annualPermitAmmoniaTons + ' 吨。',
    },
    {
      key: 'exceedance',
      title: '超标口径',
      text: '出现下列任一情形即判定当月超标：① 有有效日的日平均（COD 限值 ' + p.codDailyLimit
        + '、氨氮限值 ' + p.ammoniaDailyLimit + '）超过限值；② 折算后小时浓度超过同一限值的次数达到 '
        + p.hourlyExceedCountLimit + ' 次及以上。两项分别统计、分别给出。',
    },
  ];
}

// 找到「同参数」的既有版本（同日沿用序号，避免只改了无关字段也升版本）；否则按当天序号新开一个版本
function resolveVersion(data, params, atText) {
  const fp = fingerprint(params);
  const day = String(atText || store.nowText()).slice(0, 10).replace(/-/g, '');
  const versions = data.caliberVersions || [];
  const same = versions.find((v) => v.fingerprint === fp);
  if (same) return same.version;
  const seq = versions.filter((v) => v.version.indexOf(CALIBER_PREFIX + '-' + day) === 0).length + 1;
  return CALIBER_PREFIX + '-' + day + '-' + String(seq).padStart(2, '0');
}

// 取当前口径快照；若与已定格版本参数一致则复用版本号，否则登记新版本
function currentSnapshot(data) {
  const params = paramSnapshot(data.settings);
  const fp = fingerprint(params);
  if (!Array.isArray(data.caliberVersions)) data.caliberVersions = [];
  const existing = data.caliberVersions.find((v) => v.fingerprint === fp);
  if (existing) {
    return { version: existing.version, fingerprint: fp, params, statements: statements(params), createdAt: existing.createdAt };
  }
  const now = store.nowText();
  const version = resolveVersion(data, params, now);
  const snap = { version, fingerprint: fp, params, statements: statements(params), createdAt: now, note: '口径参数变化后定格' };
  data.caliberVersions.push(snap);
  return { version, fingerprint: fp, params, statements: snap.statements, createdAt: now };
}

// 只读地拿当前口径（不登记新版本）——预览与页面说明用
function previewSnapshot(data) {
  const params = paramSnapshot(data.settings);
  const fp = fingerprint(params);
  const versions = data.caliberVersions || [];
  const existing = versions.find((v) => v.fingerprint === fp);
  return {
    version: existing ? existing.version : '(未定稿，生成批次时定格为新版本)',
    fingerprint: fp,
    params,
    statements: statements(params),
    createdAt: existing ? existing.createdAt : '',
  };
}

function getVersion(data, version) {
  const found = (data.caliberVersions || []).find((v) => v.version === version);
  if (!found) return null;
  return { version: found.version, fingerprint: found.fingerprint, params: found.params, statements: found.statements, createdAt: found.createdAt };
}

module.exports = {
  CALIBER_PARAM_KEYS,
  paramSnapshot, fingerprint, statements,
  currentSnapshot, previewSnapshot, resolveVersion, getVersion,
};
