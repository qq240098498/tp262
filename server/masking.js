// 脱敏规则层：哪些字段保留、剔除、替换成稳定别名，全部规则化、版本化；改动留痕。
// 替换用的别名由「批次内随机 salt + 原值」HMAC 派生：同一批内稳定（外单位多次看到同一编号能对上），
// 跨批不可关联（换 salt 即变），内部另存对照表（internal-manifest，不随数据包发出）支持与内部数据对齐核查。
const crypto = require('crypto');
const { AppError } = require('./errors');
const store = require('./store');

const ACTIONS = ['hash', 'drop', 'keep'];
const ACTION_TEXT = { hash: '替换为稳定别名', drop: '整列剔除', keep: '原样保留' };

// 可维护的字段清单与默认规则。entity/field 同时也是内部数据模型的字段名，改名要同步这里
const FIELD_DEFS = [
  // 排污单位
  { entity: 'plant', field: 'id', label: '单位内部记录号', action: 'hash', aliasPrefix: 'ENT' },
  { entity: 'plant', field: 'code', label: '单位内部编号', action: 'hash', aliasPrefix: 'ENTC' },
  { entity: 'plant', field: 'name', label: '单位名称（公开标识）', action: 'keep' },
  { entity: 'plant', field: 'permitNo', label: '排污许可证号（公开标识）', action: 'keep' },
  { entity: 'plant', field: 'industry', label: '行业', action: 'keep' },
  { entity: 'plant', field: 'remark', label: '单位备注', action: 'drop' },
  // 排放口
  { entity: 'outlet', field: 'id', label: '排放口内部记录号', action: 'hash', aliasPrefix: 'OUT' },
  { entity: 'outlet', field: 'code', label: '排放口编号（公开标识）', action: 'keep' },
  { entity: 'outlet', field: 'name', label: '排放口名称（公开标识）', action: 'keep' },
  { entity: 'outlet', field: 'type', label: '排放口类型', action: 'keep' },
  { entity: 'outlet', field: 'remark', label: '排放口备注', action: 'drop' },
  // 设备
  { entity: 'device', field: 'id', label: '设备内部记录号', action: 'hash', aliasPrefix: 'DEV' },
  { entity: 'device', field: 'code', label: '设备编号', action: 'hash', aliasPrefix: 'DEVC' },
  { entity: 'device', field: 'model', label: '设备型号', action: 'keep' },
  { entity: 'device', field: 'metric', label: '设备监测指标', action: 'keep' },
  { entity: 'device', field: 'status', label: '设备状态', action: 'keep' },
  { entity: 'device', field: 'calibratedUntil', label: '校准有效期', action: 'keep' },
  { entity: 'device', field: 'remark', label: '设备备注', action: 'drop' },
  // 小时值
  { entity: 'reading', field: 'id', label: '数据内部记录号', action: 'hash', aliasPrefix: 'RID' },
  { entity: 'reading', field: 'operator', label: '登记人', action: 'hash', aliasPrefix: 'OPER' },
  { entity: 'reading', field: 'remark', label: '数据备注', action: 'drop' },
  // 小时值里的排放口/设备外键随父表的 id 规则同名替换（在构建数据行时按 outlet.id / device.id 派生，保证能关联）
];

// 数据包里不允许出现的内部关联字段之外的原始列（编号类一律走规则，不另开口子）
const ALWAYS_DROP = ['__save', '__body'];

function defaultRules() {
  return FIELD_DEFS.map((d) => ({ entity: d.entity, field: d.field, action: d.action, aliasPrefix: d.aliasPrefix || '' }));
}

function ruleIndex(rules) {
  const idx = {};
  for (const r of rules) idx[r.entity + '.' + r.field] = r;
  return idx;
}

function currentVersion(data) {
  const list = data.maskingRules || [];
  return list.length ? list[list.length - 1] : null;
}

function getVersion(data, version) {
  return (data.maskingRules || []).find((r) => r.version === version) || null;
}

function nextRuleVersion(data) {
  let max = 0;
  for (const r of data.maskingRules || []) {
    const m = String(r.version || '').match(/^msr-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'msr-' + String(max + 1).padStart(4, '0');
}

// 校验一条规则改动：字段必须在可维护清单内，动作只能是替换/剔除/保留
function validateFields(fields) {
  if (!Array.isArray(fields) || !fields.length) throw new AppError(400, 'MASKING_NO_FIELDS', '至少要给一条字段规则');
  const errors = {};
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    const def = FIELD_DEFS.find((d) => d.entity === f.entity && d.field === f.field);
    const where = '第 ' + (i + 1) + ' 条（' + f.entity + '.' + f.field + '）';
    if (!def) errors[i] = where + ' 不在可维护字段清单内';
    else if (!ACTIONS.includes(f.action)) errors[i] = where + ' 动作只能是：' + ACTIONS.join('、');
    else if (f.action === 'hash' && !String(f.aliasPrefix || '').trim()) errors[i] = where + ' 替换动作必须给别名前缀';
  }
  if (Object.keys(errors).length) throw new AppError(400, 'MASKING_RULE_INVALID', '脱敏字段规则没通过校验', errors);
}

function normalizeFields(fields) {
  return fields.map((f) => ({
    entity: String(f.entity),
    field: String(f.field),
    action: String(f.action),
    aliasPrefix: f.action === 'hash' ? String(f.aliasPrefix || '').trim().toUpperCase() : '',
  }));
}

// 改动规则：旧版本原样保留（历史批次仍按旧版本解释），另登记新版本与逐条变更留痕
function updateRules(data, payload) {
  const fields = normalizeFields(payload.fields || []);
  validateFields(fields);
  if (!Array.isArray(data.maskingRules)) data.maskingRules = [];
  if (!Array.isArray(data.maskingRuleChanges)) data.maskingRuleChanges = [];
  const current = currentVersion(data);
  const oldIdx = ruleIndex(current ? current.fields : defaultRules());
  const newIdx = ruleIndex(fields);

  // 必须覆盖整份清单，漏给的字段按默认规则解释，避免「没人管的字段」悄悄流出
  const full = ruleIndex(defaultRules());
  for (const k of Object.keys(newIdx)) full[k] = newIdx[k];
  const merged = defaultRules().map((d) => full[d.entity + '.' + d.field]);

  const changes = [];
  for (const def of FIELD_DEFS) {
    const key = def.entity + '.' + def.field;
    const before = oldIdx[key];
    const after = newIdx[key];
    if (!after) continue; // 本次没提的字段不动
    if (!before || before.action !== after.action || (before.aliasPrefix || '') !== (after.aliasPrefix || '')) {
      changes.push({
        entity: def.entity, field: def.field, label: def.label,
        oldAction: before ? before.action : '(默认' + defaultRules().find((d) => d.entity === def.entity && d.field === def.field).action + ')',
        newAction: after.action,
        oldAliasPrefix: before ? before.aliasPrefix || '' : '',
        newAliasPrefix: after.aliasPrefix || '',
      });
    }
  }
  if (!changes.length) throw new AppError(409, 'MASKING_NO_CHANGE', '规则与现行版本一致，没有需要留痕的改动');

  const version = nextRuleVersion(data);
  const now = store.nowText();
  const saved = {
    version,
    createdAt: now,
    createdBy: String(payload.operator || '').trim(),
    note: String(payload.note || '').trim(),
    basedOn: current ? current.version : '',
    fields: merged,
  };
  data.maskingRules.push(saved);
  data.maskingRuleChanges.push({
    at: now,
    operator: saved.createdBy,
    fromVersion: current ? current.version : '(默认规则)',
    toVersion: version,
    note: saved.note,
    changes,
  });
  return { version: saved, changes };
}

// 稳定别名：HMAC-SHA256(批次 salt, 实体.字段=原值) 取 8 位；极小概率碰撞时扩到 12 位
function deriveAlias(salt, entity, field, prefix, value, width) {
  const mac = crypto.createHmac('sha256', salt).update(entity + '.' + field + '=' + String(value), 'utf8').digest('hex');
  return prefix + '-' + mac.slice(0, width || 8).toUpperCase();
}

// 一批脱敏过程的有状态执行器：边替换边记对照表
function session(ruleVersion, salt) {
  const rules = ruleIndex(ruleVersion.fields);
  const usedAliases = {}; // alias -> key，碰撞检测
  const alignMap = {};    // entity.field -> { 原值: 别名 }（仅替换类）
  const stats = { hash: 0, drop: 0, keep: 0 };

  function ruleFor(entity, field) {
    return rules[entity + '.' + field] || FIELD_DEFS.find((d) => d.entity === entity && d.field === field)
      || { action: 'drop', aliasPrefix: '' };
  }

  function aliasFor(entity, field, prefix, rawValue) {
    const key = entity + '.' + field;
    if (!alignMap[key]) alignMap[key] = {};
    const map = alignMap[key];
    const rawKey = String(rawValue);
    if (map[rawKey]) return map[rawKey];
    let alias = deriveAlias(salt, entity, field, prefix || 'ID', rawKey, 8);
    while (usedAliases[alias] && usedAliases[alias] !== key) alias = deriveAlias(salt, entity, field, prefix || 'ID', rawKey, 12);
    usedAliases[alias] = key;
    map[rawKey] = alias;
    return alias;
  }

  // 取一个字段对外给什么：{send:false} 剔除；{send:true, value} 对外值
  function apply(entity, field, rawValue) {
    const rule = ruleFor(entity, field);
    if (rule.action === 'drop') { stats.drop += 1; return { send: false }; }
    if (rule.action === 'keep') { stats.keep += 1; return { send: true, value: rawValue == null ? '' : rawValue }; }
    stats.hash += 1;
    return { send: true, value: aliasFor(entity, field, rule.aliasPrefix, rawValue) };
  }

  return { apply, alignMap, stats, version: ruleVersion.version };
}

// 反查：把外部手里的别名还原成内部原值（在内部对照表里查，不输出 salt）
function lookupAlias(alignMap, alias) {
  const out = [];
  for (const key of Object.keys(alignMap || {})) {
    for (const raw of Object.keys(alignMap[key])) {
      if (alignMap[key][raw] === alias) {
        const [entity, field] = key.split('.');
        out.push({ entity, field, internalValue: raw, alias });
      }
    }
  }
  return out;
}

function publicRuleView(ruleVersion) {
  return {
    version: ruleVersion.version,
    createdAt: ruleVersion.createdAt,
    note: ruleVersion.note,
    fields: ruleVersion.fields.map((f) => {
      const def = FIELD_DEFS.find((d) => d.entity === f.entity && d.field === f.field) || { label: f.field };
      return {
        entity: f.entity, field: f.field, label: def.label,
        action: f.action, actionText: ACTION_TEXT[f.action] || f.action,
        aliasPrefix: f.aliasPrefix || '',
      };
    }),
  };
}

module.exports = {
  ACTIONS, ACTION_TEXT, FIELD_DEFS,
  defaultRules, currentVersion, getVersion, nextRuleVersion,
  updateRules, session, lookupAlias, deriveAlias, publicRuleView,
};
