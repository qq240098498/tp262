/* 污染源在线监测与排污总量核算台 —— 纯原生前端
   显示纪律：除「折算后浓度（页面自算）」外，所有数字直接用接口返回值。 */
(function () {
  'use strict';

  /* ================= 常量（与后端校验口径一致） ================= */
  var METRICS = ['COD', '氨氮', '流量', '氧含量'];
  var MAIN_METRICS = ['COD', '氨氮'];
  var PLANT_STATUS = ['生产', '停产', '调试'];
  var OUTLET_STATUS = ['运行', '停用'];
  var OUTLET_TYPE = ['主要排放口', '一般排放口'];
  var DEVICE_STATUS = ['正常', '校准', '维护', '故障'];
  var FLAGS = ['有效', '无效'];
  var SOURCES = ['自动', '补录'];
  var REPORT_STATUS = ['草稿', '已上报', '退回'];

  /* ================= 全局状态 ================= */
  var state = {
    view: 'overview',
    today: '',
    month: '',
    settings: null,
    summary: null,
    plants: [],
    outlets: [],
    devices: [],
    reports: [],
    readings: { total: 0, returned: 0, rows: [] },
    plantsFilter: { status: '', keyword: '' },
    outletsFilter: { plantId: '', status: '' },
    devicesFilter: { outletId: '', metric: '', status: '' },
    readingsFilter: { outletId: '', deviceId: '', metric: '', day: '', month: '' },
    accounting: { outletId: '', month: '', metric: 'COD' },
    share: {
      catalog: null,
      outlets: {},
      metrics: { COD: true, '氨氮': true, '流量': false, '氧含量': false },
      from: '', to: '', operator: '',
      preview: null,
      batches: [],
      caliberLog: [],
      mask: null,
      maskDraft: null,
      maskNote: '', maskOperator: '',
      verify: {}
    }
  };

  /* ================= 基础工具 ================= */
  function appendChildren(node, list) {
    list.forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { appendChildren(node, c); return; }
      if (typeof c === 'object' && c.nodeType) node.appendChild(c);
      else node.appendChild(document.createTextNode(String(c)));
    });
  }

  function h(tag, props) {
    var node = document.createElement(tag);
    var children = Array.prototype.slice.call(arguments, 2);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') { Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; }); }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      });
    }
    appendChildren(node, children);
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  async function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    var res = await fetch(path, opts);
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var err = (data && data.error) ? data.error : {};
      var ex = new Error(err.message || ('请求失败（HTTP ' + res.status + '）'));
      ex.code = err.code || ('HTTP_' + res.status);
      ex.details = err.details || null;
      ex.status = res.status;
      throw ex;
    }
    return data;
  }

  function qs(obj) {
    var parts = [];
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v !== '' && v !== null && v !== undefined) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? ('?' + parts.join('&')) : '';
  }

  function textOf(v) {
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
  }
  function num(v, digits) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    var d = (digits === null || digits === undefined) ? 2 : digits;
    var f = Math.pow(10, d);
    return Math.round(n * f) / f;
  }
  function fmt(v, digits) {
    var n = num(v, digits);
    return n === null ? '—' : String(n);
  }
  function metricOf(rows, name) {
    rows = rows || [];
    for (var i = 0; i < rows.length; i++) if (rows[i].metric === name) return rows[i];
    return { metric: name };
  }

  /* 折算后浓度（页面自算）：实测 × (21 − 基准氧) / (21 − 实测氧含量)，氧含量缺失按基准氧处理 */
  function pageConcentration(row) {
    var base = (state.settings && state.settings.oxygenBaseline !== null && state.settings.oxygenBaseline !== undefined)
      ? Number(state.settings.oxygenBaseline) : 8;
    var oxy = (row.oxygen === null || row.oxygen === undefined || row.oxygen === '') ? base : Number(row.oxygen);
    var denom = 21 - oxy;
    if (!isFinite(denom) || denom === 0) return null;
    var value = Number(row.value);
    if (!isFinite(value)) return null;
    return value * (21 - base) / denom;
  }

  /* ================= 错误提示 ================= */
  var errorBanner = document.getElementById('errorBanner');
  var errorDetails = document.getElementById('errorDetails');
  function showError(e) {
    document.getElementById('errorMessage').textContent = (e && e.message) ? e.message : '操作没成功';
    clear(errorDetails);
    var details = e ? e.details : null;
    var fields = [];
    if (details && typeof details === 'object') {
      Object.keys(details).forEach(function (k) {
        fields.push(k);
        errorDetails.appendChild(h('li', { text: k + '：' + details[k] }));
      });
      errorDetails.hidden = false;
    } else if (details) {
      errorDetails.appendChild(h('li', { text: String(details) }));
      errorDetails.hidden = false;
    } else {
      errorDetails.hidden = true;
    }
    fields.forEach(function (k) {
      var input = document.querySelector('[data-field="' + k + '"]');
      if (input) input.classList.add('is-invalid');
    });
    errorBanner.hidden = false;
  }
  function clearError() {
    errorBanner.hidden = true;
    document.querySelectorAll('.is-invalid').forEach(function (n) { n.classList.remove('is-invalid'); });
  }
  document.getElementById('errorClose').addEventListener('click', clearError);

  /* ================= 轻提示 ================= */
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2400);
  }

  /* ================= 弹层 ================= */
  var modalMask = document.getElementById('modalMask');
  function openModal(title, bodyNode, footNodes) {
    document.getElementById('modalTitle').textContent = title;
    clear(document.getElementById('modalBody')).appendChild(bodyNode);
    var foot = clear(document.getElementById('modalFoot'));
    (footNodes || []).forEach(function (n) { foot.appendChild(n); });
    modalMask.hidden = false;
  }
  function closeModal() { modalMask.hidden = true; }
  document.getElementById('modalClose').addEventListener('click', closeModal);
  modalMask.addEventListener('click', function (e) { if (e.target === modalMask) closeModal(); });

  function formField(field, value) {
    var wrap = h('div', { class: 'field' + (field.full ? ' full' : '') });
    wrap.appendChild(h('label', { text: field.label }));
    var input;
    if (field.type === 'select') {
      input = h('select', { dataset: { field: field.name } });
      (field.options || []).forEach(function (opt) {
        var val = (typeof opt === 'object') ? opt.value : opt;
        var lab = (typeof opt === 'object') ? opt.label : opt;
        input.appendChild(h('option', { value: val, text: lab }));
      });
      input.value = (value === null || value === undefined) ? '' : String(value);
    } else {
      input = h('input', { type: field.type || 'text', dataset: { field: field.name } });
      input.value = (value === null || value === undefined) ? '' : String(value);
    }
    wrap.appendChild(input);
    return wrap;
  }
  function buildForm(fields, values) {
    values = values || {};
    var grid = h('div', { class: 'form-grid' });
    fields.forEach(function (f) { grid.appendChild(formField(f, values[f.name])); });
    return grid;
  }
  function collectForm(root) {
    var out = {};
    root.querySelectorAll('[data-field]').forEach(function (n) { out[n.dataset.field] = n.value; });
    return out;
  }

  /* ================= 按钮 / 行 ================= */
  function actionBtn(label, fn, cls) {
    return h('button', {
      type: 'button',
      class: 'btn btn-sm ' + (cls || 'btn-ghost'),
      text: label,
      onclick: function (ev) { ev.stopPropagation(); fn(ev); }
    });
  }

  function deleteBtn(label, run) {
    var btn = h('button', { type: 'button', class: 'btn btn-sm btn-danger', text: label });
    var armed = false;
    var timer = null;
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!armed) {
        armed = true;
        btn.textContent = '确认删除';
        timer = setTimeout(function () { armed = false; btn.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer);
      armed = false;
      btn.disabled = true;
      btn.textContent = '删除中…';
      Promise.resolve().then(run).catch(function (e) {
        btn.disabled = false;
        btn.textContent = label;
        showError(e);
      });
    });
    return btn;
  }

  function actionsCell(buttons) {
    var box = h('div', { class: 'inline-actions' });
    buttons.forEach(function (b) { box.appendChild(b); });
    return h('td', { class: 'nowrap' }, box);
  }

  function expandableRow(cells, detailFactory) {
    var tr = h('tr', { class: 'row' }, cells);
    var detailTr = null;
    tr.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('.inline-actions')) return;
      if (detailTr) {
        var willShow = detailTr.hidden;
        detailTr.hidden = !willShow;
        tr.classList.toggle('is-open', willShow);
        return;
      }
      var td = h('td', { colspan: String(cells.length) }, h('span', { class: 'empty', text: '加载中…' }));
      detailTr = h('tr', { class: 'expand-row' }, td);
      tr.classList.add('is-open');
      tr.parentNode.insertBefore(detailTr, tr.nextSibling);
      Promise.resolve().then(detailFactory).then(function (node) {
        clear(td).appendChild(node);
      }).catch(function (e) {
        clear(td).appendChild(h('div', { class: 'empty', text: '明细加载失败：' + e.message }));
      });
    });
    return tr;
  }

  function sel(pairs, value, onChange) {
    var s = h('select');
    pairs.forEach(function (p) { s.appendChild(h('option', { value: p.value, text: p.label })); });
    s.value = (value === null || value === undefined) ? '' : String(value);
    if (onChange) s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }
  function optsFromList(list) {
    return [{ value: '', label: '全部' }].concat(list.map(function (x) { return { value: x, label: x }; }));
  }
  function statusTag(status, okValue) {
    var cls = status === okValue ? 'tag-ok' : (status === '退回' || status === '停产' || status === '停用' || status === '故障' ? 'tag-danger' : 'tag-warn');
    return h('span', { class: 'tag ' + cls, text: status });
  }

  /* ================= 数据加载 ================= */
  async function loadAll() {
    var res = await Promise.all([
      api('GET', '/api/summary'),
      api('GET', '/api/settings'),
      api('GET', '/api/plants'),
      api('GET', '/api/outlets'),
      api('GET', '/api/devices'),
      api('GET', '/api/readings'),
      api('GET', '/api/reports')
    ]);
    state.summary = res[0];
    state.settings = res[1];
    state.plants = res[2];
    state.outlets = res[3];
    state.devices = res[4];
    state.readings = res[5];
    state.reports = res[6];
    state.today = state.summary.today;
    state.month = state.summary.month;
    if (!state.accounting.outletId && state.outlets.length) state.accounting.outletId = state.outlets[0].id;
    state.accounting.month = state.month;
  }

  async function reloadCore() {
    var res = await Promise.all([
      api('GET', '/api/plants'),
      api('GET', '/api/outlets'),
      api('GET', '/api/devices'),
      api('GET', '/api/reports'),
      api('GET', '/api/summary')
    ]);
    state.plants = res[0];
    state.outlets = res[1];
    state.devices = res[2];
    state.reports = res[3];
    state.summary = res[4];
  }

  function afterMutation(msg) {
    return reloadCore().then(function () {
      toast(msg);
      switchView(state.view);
    }).catch(showError);
  }

  /* ================= 视图切换 ================= */
  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('is-active', t.dataset.view === view); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('is-active', v.dataset.view === view); });
    clearError();
    if (view === 'overview') renderOverview();
    else if (view === 'plants') renderPlants();
    else if (view === 'devices') renderDevices();
    else if (view === 'readings') renderReadings();
    else if (view === 'accounting') renderAccounting();
    else if (view === 'share') renderShare();
  }

  /* ================= 概览 ================= */
  function metricCard(title, main, foot, targetView) {
    return h('button', {
      type: 'button', class: 'metric-card',
      onclick: function () { switchView(targetView); }
    }, [
      h('div', { class: 'm-title', text: title }),
      h('div', { class: 'm-main', text: String(main) }),
      h('div', { class: 'm-foot', text: foot })
    ]);
  }

  function renderOverview() {
    var f = clear(document.getElementById('filters-overview'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '概览' }),
      h('p', { class: 'hint', text: '本页所有数字均直接取 /api/summary 的返回字段，前端不做计算。' })
    ]));

    var c = clear(document.getElementById('content-overview'));
    var s = state.summary;
    if (!s) { c.appendChild(h('div', { class: 'empty', text: '概览数据还没加载好' })); return; }

    var ds = s.deviceStatus || {};
    var dsText = Object.keys(ds).map(function (k) { return k + ' ' + ds[k] + ' 台'; }).join('、') || '暂无设备';

    c.appendChild(h('div', { class: 'metric-grid' }, [
      metricCard('排污单位', s.plantCount, '生产中 ' + s.producingCount + ' 家', 'plants'),
      metricCard('排放口', s.outletCount, '运行中 ' + s.runningOutletCount + ' 个', 'plants'),
      metricCard('在线设备', s.deviceCount, dsText, 'devices'),
      metricCard('监测数据', s.readingCount, '自动 ' + s.autoCount + ' · 补录 ' + s.imputedCount + ' · 无效标记 ' + s.invalidFlagCount, 'readings'),
      metricCard('报表', s.reportCount, '已上报 ' + s.submittedReportCount + ' 张', 'accounting'),
      metricCard('超标排放口', s.exceededOutletCount, '存在月超标判定', 'accounting'),
      metricCard('年累计 COD', s.accumulatedCodTons + ' 吨', '年许可量 ' + s.permitCodTons + ' 吨', 'accounting'),
      metricCard('年累计氨氮', s.accumulatedAmmoniaTons + ' 吨', '年许可量 ' + s.permitAmmoniaTons + ' 吨', 'accounting')
    ]));

    var tb = h('tbody');
    (s.outlets || []).forEach(function (o) {
      var cod = metricOf(o.rows, 'COD');
      var amm = metricOf(o.rows, '氨氮');
      var tr = h('tr', { class: 'row', title: '点此行到「核算与报表」查看该排放口' }, [
        h('td', {}, [h('b', { text: o.code }), ' ', o.name]),
        h('td', { text: textOf(o.plantName) }),
        h('td', { text: textOf(o.type) }),
        h('td', {}, statusTag(o.status, '运行')),
        h('td', { class: 'mono', text: fmt(cod.monthAverage) }),
        h('td', { class: 'mono', text: fmt(cod.monthTotalTons, 4) }),
        h('td', { class: 'mono' + (Number(cod.exceedDaysCount) > 0 ? ' num-danger' : ''), text: textOf(cod.exceedDaysCount) }),
        h('td', { class: 'mono', text: textOf(cod.exceedHours) }),
        h('td', { class: 'mono', text: fmt(amm.monthAverage) }),
        h('td', { class: 'mono', text: fmt(amm.monthTotalTons, 4) }),
        h('td', { class: 'mono' + (Number(amm.exceedDaysCount) > 0 ? ' num-danger' : ''), text: textOf(amm.exceedDaysCount) }),
        h('td', { class: 'mono', text: textOf(amm.exceedHours) })
      ]);
      tr.addEventListener('click', function () {
        state.accounting.outletId = o.id;
        state.accounting.month = s.month || state.month;
        switchView('accounting');
      });
      tb.appendChild(tr);
    });

    var table = h('table', { id: 'tableOverviewOutlet' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '排放口' }), h('th', { text: '所属单位' }), h('th', { text: '类型' }), h('th', { text: '状态' }),
        h('th', { text: 'COD 月均' }), h('th', { text: 'COD 月总量(吨)' }), h('th', { text: 'COD 超标天数' }), h('th', { text: 'COD 超标小时' }),
        h('th', { text: '氨氮 月均' }), h('th', { text: '氨氮 月总量(吨)' }), h('th', { text: '氨氮 超标天数' }), h('th', { text: '氨氮 超标小时' })
      ])),
      tb
    ]);

    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '本月各排放口 COD / 氨氮 情况' }),
        h('span', { class: 'sub', text: '月份 ' + s.month + '（点行跳到核算页并选中该排放口）' })
      ]),
      h('div', { class: 'table-wrap' }, table)
    ]));
  }

  /* ================= 单位与排放口 ================= */
  function plantDetailNode(id) {
    return api('GET', '/api/plants/' + id).then(function (d) {
      var box = h('div', { class: 'detail-grid' });
      var og = h('div', { class: 'detail-block' });
      og.appendChild(h('h3', { text: '排放口清单（' + ((d.outlets || []).length) + '）' }));
      if (!d.outlets || !d.outlets.length) og.appendChild(h('div', { class: 'empty', text: '暂无排放口' }));
      else {
        var tb = h('tbody');
        d.outlets.forEach(function (o) {
          tb.appendChild(h('tr', { class: 'row' }, [
            h('td', { text: o.code }), h('td', { text: o.name }), h('td', { text: o.type }),
            h('td', {}, statusTag(o.status, '运行')),
            h('td', { class: 'mono', text: textOf(o.deviceCount) }), h('td', { class: 'mono', text: textOf(o.readingCount) })
          ]));
        });
        og.appendChild(h('table', {}, [h('thead', {}, h('tr', {}, [
          h('th', { text: '编码' }), h('th', { text: '名称' }), h('th', { text: '类型' }), h('th', { text: '状态' }),
          h('th', { text: '设备数' }), h('th', { text: '数据条数' })
        ])), tb]));
      }
      box.appendChild(og);

      var rg = h('div', { class: 'detail-block' });
      rg.appendChild(h('h3', { text: '报表（' + ((d.reports || []).length) + '）' }));
      if (!d.reports || !d.reports.length) rg.appendChild(h('div', { class: 'empty', text: '暂无报表' }));
      else {
        var tb2 = h('tbody');
        d.reports.forEach(function (r) {
          tb2.appendChild(h('tr', { class: 'row' }, [
            h('td', { text: r.period }), h('td', {}, statusTag(r.status, '已上报')),
            h('td', { text: textOf(r.submittedAt) }), h('td', { text: textOf(r.submittedBy) })
          ]));
        });
        rg.appendChild(h('table', {}, [h('thead', {}, h('tr', {}, [
          h('th', { text: '期间' }), h('th', { text: '状态' }), h('th', { text: '上报时刻' }), h('th', { text: '上报人' })
        ])), tb2]));
      }
      box.appendChild(rg);
      return box;
    });
  }

  function plantRow(p) {
    var actions = actionsCell([
      actionBtn('修改', function () { openPlantForm(p); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/plants/' + p.id).then(function () { return afterMutation('已删除单位 ' + p.code); });
      })
    ]);
    return expandableRow([
      h('td', {}, h('b', { text: p.code })),
      h('td', { text: p.name }),
      h('td', { text: textOf(p.industry) }),
      h('td', {}, statusTag(p.status, '生产')),
      h('td', { text: textOf(p.permitNo) }),
      h('td', { class: 'mono', text: textOf(p.outletCount) }),
      h('td', { class: 'mono', text: textOf(p.deviceCount) }),
      h('td', { class: 'mono', text: textOf(p.readingCount) }),
      h('td', { class: 'mono', text: textOf(p.reportCount) }),
      actions
    ], function () { return plantDetailNode(p.id); });
  }

  function outletRow(o) {
    var actions = actionsCell([
      actionBtn('修改', function () { openOutletForm(o); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/outlets/' + o.id).then(function () { return afterMutation('已删除排放口 ' + o.code); });
      })
    ]);
    return expandableRow([
      h('td', {}, h('b', { text: o.code })),
      h('td', { text: textOf(o.name) }),
      h('td', { text: textOf(o.plantCode + ' ' + o.plantName).trim() || '—' }),
      h('td', { text: textOf(o.type) }),
      h('td', {}, statusTag(o.status, '运行')),
      h('td', { class: 'mono', text: textOf(o.deviceCount) }),
      h('td', { class: 'mono', text: textOf(o.readingCount) }),
      actions
    ], function () {
      var box = h('div', { class: 'detail-grid' });
      box.appendChild(h('div', { class: 'detail-block' }, [
        h('h3', { text: '备注' }),
        h('div', { text: textOf(o.remark) })
      ]));
      var devs = state.devices.filter(function (d) { return d.outletId === o.id; });
      var db = h('div', { class: 'detail-block' });
      db.appendChild(h('h3', { text: '设备（' + devs.length + '）' }));
      if (!devs.length) db.appendChild(h('div', { class: 'empty', text: '暂无设备' }));
      else {
        var tb = h('tbody');
        devs.forEach(function (d) {
          tb.appendChild(h('tr', { class: 'row' }, [
            h('td', { text: d.code }), h('td', { text: d.metric }), h('td', {}, statusTag(d.status, '正常')),
            h('td', { text: textOf(d.calibratedUntil) })
          ]));
        });
        db.appendChild(h('table', {}, [h('thead', {}, h('tr', {}, [
          h('th', { text: '编号' }), h('th', { text: '指标' }), h('th', { text: '状态' }), h('th', { text: '校准有效期' })
        ])), tb]));
      }
      box.appendChild(db);
      return box;
    });
  }

  async function renderPlants() {
    var f = clear(document.getElementById('filters-plants'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '排污单位' }),
      h('div', { class: 'field' }, [h('label', { text: '状态' }),
        sel(optsFromList(PLANT_STATUS), state.plantsFilter.status, function (v) { state.plantsFilter.status = v; renderPlants(); })]),
      (function () {
        var kw = h('input', { type: 'text', placeholder: '编码/名称/行业' });
        kw.value = state.plantsFilter.keyword;
        kw.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.plantsFilter.keyword = kw.value.trim(); renderPlants(); } });
        return h('div', { class: 'field' }, [h('label', { text: '关键字' }), kw, h('div', { class: 'hint', text: '回车应用（走接口筛选）' })]);
      })()
    ]));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '排放口' }),
      h('div', { class: 'field' }, [h('label', { text: '所属单位' }),
        sel([{ value: '', label: '全部单位' }].concat(state.plants.map(function (p) { return { value: p.id, label: p.code + ' ' + p.name }; })),
          state.outletsFilter.plantId, function (v) { state.outletsFilter.plantId = v; renderPlants(); })]),
      h('div', { class: 'field' }, [h('label', { text: '状态' }),
        sel(optsFromList(OUTLET_STATUS), state.outletsFilter.status, function (v) { state.outletsFilter.status = v; renderPlants(); })])
    ]));

    var c = clear(document.getElementById('content-plants'));
    var plantsRes, outletsRes;
    try {
      plantsRes = await api('GET', '/api/plants' + qs(state.plantsFilter));
      outletsRes = await api('GET', '/api/outlets' + qs(state.outletsFilter));
    } catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }

    var unitTb = h('tbody');
    plantsRes.forEach(function (p) { unitTb.appendChild(plantRow(p)); });
    var unitTable = h('table', { id: 'tableUnits' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '编码' }), h('th', { text: '名称' }), h('th', { text: '行业' }), h('th', { text: '状态' }),
        h('th', { text: '许可证号' }), h('th', { text: '排放口数' }), h('th', { text: '设备数' }),
        h('th', { text: '数据条数' }), h('th', { text: '报表数' }), h('th', { text: '操作' })
      ])),
      unitTb
    ]);
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '排污单位台账' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + plantsRes.length + ' 家（点行展开排放口与报表）' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新增单位', onclick: function () { openPlantForm(null); } })
        ])
      ]),
      h('div', { class: 'table-wrap' }, unitTable)
    ]));

    var outletTb = h('tbody');
    outletsRes.forEach(function (o) { outletTb.appendChild(outletRow(o)); });
    var outletTable = h('table', { id: 'tableOutlets' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '编码' }), h('th', { text: '名称' }), h('th', { text: '所属单位' }), h('th', { text: '类型' }),
        h('th', { text: '状态' }), h('th', { text: '设备数' }), h('th', { text: '数据条数' }), h('th', { text: '操作' })
      ])),
      outletTb
    ]);
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '排放口台账' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + outletsRes.length + ' 个' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新增排放口', onclick: function () { openOutletForm(null); } })
        ])
      ]),
      h('div', { class: 'table-wrap' }, outletTable)
    ]));
  }

  function openPlantForm(plant) {
    var fields = [
      { name: 'code', label: '编码' },
      { name: 'name', label: '名称' },
      { name: 'industry', label: '行业' },
      { name: 'status', label: '状态', type: 'select', options: PLANT_STATUS },
      { name: 'permitNo', label: '排污许可证号' },
      { name: 'permitYearStart', label: '许可年起始日（YYYY-MM-DD）' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, plant || { status: '生产', permitYearStart: (state.settings && state.settings.permitYearStart) || '2026-01-01' });
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      var p = plant ? api('PATCH', '/api/plants/' + plant.id, payload) : api('POST', '/api/plants', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(plant ? '单位已修改' : '单位已新增'); }).catch(showError);
    });
    openModal(plant ? '修改排污单位' : '新增排污单位', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  function openOutletForm(outlet) {
    var fields = [
      { name: 'code', label: '编码' },
      { name: 'name', label: '名称' },
      { name: 'plantId', label: '所属单位', type: 'select', options: state.plants.map(function (p) { return { value: p.id, label: p.code + ' ' + p.name }; }) },
      { name: 'type', label: '类型', type: 'select', options: OUTLET_TYPE },
      { name: 'status', label: '状态', type: 'select', options: OUTLET_STATUS },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, outlet || { type: '主要排放口', status: '运行', plantId: state.plants.length ? state.plants[0].id : '' });
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      var p = outlet ? api('PATCH', '/api/outlets/' + outlet.id, payload) : api('POST', '/api/outlets', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(outlet ? '排放口已修改' : '排放口已新增'); }).catch(showError);
    });
    openModal(outlet ? '修改排放口' : '新增排放口', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  /* ================= 在线设备 ================= */
  function deviceRow(d) {
    var actions = actionsCell([
      actionBtn('修改', function () { openDeviceForm(d); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/devices/' + d.id).then(function () { return afterMutation('已删除设备 ' + d.code); });
      })
    ]);
    var outlet = state.outlets.filter(function (o) { return o.id === d.outletId; })[0];
    return expandableRow([
      h('td', {}, h('b', { text: d.code })),
      h('td', { text: outlet ? (outlet.code + ' ' + outlet.name) : textOf(d.outletCode) }),
      h('td', { text: d.metric }),
      h('td', { text: textOf(d.model) }),
      h('td', {}, statusTag(d.status, '正常')),
      h('td', { text: textOf(d.calibratedUntil) }),
      h('td', { class: 'mono', text: textOf(d.readingCount) }),
      h('td', { class: 'mono' + (Number(d.invalidCount) > 0 ? ' num-danger' : ''), text: textOf(d.invalidCount) }),
      actions
    ], function () {
      return h('div', { class: 'detail-grid' }, [
        h('div', { class: 'detail-block' }, [h('h3', { text: '设备 ID' }), h('div', { text: d.id })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '备注' }), h('div', { text: textOf(d.remark) })])
      ]);
    });
  }

  async function renderDevices() {
    var f = clear(document.getElementById('filters-devices'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '设备筛选' }),
      h('div', { class: 'field' }, [h('label', { text: '所属排放口' }),
        sel([{ value: '', label: '全部排放口' }].concat(state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; })),
          state.devicesFilter.outletId, function (v) { state.devicesFilter.outletId = v; renderDevices(); })]),
      h('div', { class: 'field' }, [h('label', { text: '监测指标' }),
        sel(optsFromList(METRICS), state.devicesFilter.metric, function (v) { state.devicesFilter.metric = v; renderDevices(); })]),
      h('div', { class: 'field' }, [h('label', { text: '设备状态' }),
        sel(optsFromList(DEVICE_STATUS), state.devicesFilter.status, function (v) { state.devicesFilter.status = v; renderDevices(); })])
    ]));

    var c = clear(document.getElementById('content-devices'));
    var list;
    try { list = await api('GET', '/api/devices' + qs(state.devicesFilter)); }
    catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }

    var tb = h('tbody');
    list.forEach(function (d) { tb.appendChild(deviceRow(d)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '在线设备台账' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + list.length + ' 台' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新增设备', onclick: function () { openDeviceForm(null); } })
        ])
      ]),
      h('div', { class: 'table-wrap' }, h('table', { id: 'tableDevices' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '编号' }), h('th', { text: '所属排放口' }), h('th', { text: '指标' }), h('th', { text: '型号' }),
          h('th', { text: '状态' }), h('th', { text: '校准有效期' }), h('th', { text: '数据条数' }),
          h('th', { text: '无效标记条数' }), h('th', { text: '操作' })
        ])),
        tb
      ]))
    ]));
  }

  function openDeviceForm(device) {
    var fields = [
      { name: 'code', label: '设备编号' },
      { name: 'outletId', label: '所属排放口', type: 'select', options: state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; }) },
      { name: 'metric', label: '监测指标', type: 'select', options: METRICS },
      { name: 'model', label: '型号' },
      { name: 'status', label: '设备状态', type: 'select', options: DEVICE_STATUS },
      { name: 'calibratedUntil', label: '校准有效期（YYYY-MM-DD）' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, device || { status: '正常', metric: 'COD', outletId: state.outlets.length ? state.outlets[0].id : '' });
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      var p = device ? api('PATCH', '/api/devices/' + device.id, payload) : api('POST', '/api/devices', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(device ? '设备已修改' : '设备已新增'); }).catch(showError);
    });
    openModal(device ? '修改设备' : '新增设备', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  /* ================= 监测数据 ================= */
  function readingRow(r) {
    var pc = pageConcentration(r);
    var actions = actionsCell([
      actionBtn('修改', function () { openReadingForm(r); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/readings/' + r.id).then(function () { return afterMutation('已删除监测数据 ' + r.id); });
      })
    ]);
    return expandableRow([
      h('td', { text: textOf(r.outletCode) }),
      h('td', { text: textOf(r.deviceCode) }),
      h('td', { text: r.metric }),
      h('td', { class: 'nowrap', text: r.at }),
      h('td', { class: 'mono', text: textOf(r.value) }),
      h('td', {}, h('span', { class: 'tag ' + (r.flag === '有效' ? 'tag-ok' : 'tag-danger'), text: r.flag })),
      h('td', { text: r.source }),
      h('td', { text: textOf(r.operator) }),
      h('td', {}, h('span', { class: 'tag ' + (r.counted ? 'tag-ok' : 'tag-danger'), text: r.counted ? '计入' : (r.stopped ? '不计入（停产/停用）' : '不计入') })),
      h('td', { class: 'mono cell-page-conc', dataset: { value: pc === null ? '' : String(pc) }, text: pc === null ? '—' : fmt(pc, 2) }),
      h('td', { class: 'mono cell-api-conc', dataset: { value: (r.concentration === null || r.concentration === undefined) ? '' : String(r.concentration) }, text: textOf(r.concentration) }),
      h('td', { class: 'mono', text: textOf(r.oxygen) }),
      h('td', { class: 'mono', text: textOf(r.flow) }),
      actions
    ], function () {
      return h('div', { class: 'detail-grid' }, [
        h('div', { class: 'detail-block' }, [h('h3', { text: '数据 ID' }), h('div', { text: r.id })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '设备状态' }), h('div', { text: textOf(r.deviceStatus) })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '备注' }), h('div', { text: textOf(r.remark) })])
      ]);
    });
  }

  async function renderReadings() {
    var f = clear(document.getElementById('filters-readings'));
    var outletSel = sel([{ value: '', label: '全部排放口' }].concat(state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; })),
      state.readingsFilter.outletId, function (v) {
        state.readingsFilter.outletId = v;
        if (v && state.readingsFilter.deviceId) {
          var ok = state.devices.some(function (d) { return d.id === state.readingsFilter.deviceId && d.outletId === v; });
          if (!ok) state.readingsFilter.deviceId = '';
        }
        renderReadings();
      });
    var devPool = state.readingsFilter.outletId
      ? state.devices.filter(function (d) { return d.outletId === state.readingsFilter.outletId; })
      : state.devices;
    var deviceSel = sel([{ value: '', label: '全部设备' }].concat(devPool.map(function (d) { return { value: d.id, label: d.code }; })),
      state.readingsFilter.deviceId, function (v) { state.readingsFilter.deviceId = v; renderReadings(); });
    var metricSel = sel(optsFromList(METRICS), state.readingsFilter.metric, function (v) { state.readingsFilter.metric = v; renderReadings(); });
    var dayInput = h('input', { type: 'date' });
    dayInput.value = state.readingsFilter.day;
    dayInput.addEventListener('change', function () { state.readingsFilter.day = dayInput.value; renderReadings(); });
    var monthInput = h('input', { type: 'month' });
    monthInput.value = state.readingsFilter.month;
    monthInput.addEventListener('change', function () { state.readingsFilter.month = monthInput.value; renderReadings(); });

    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '监测数据筛选' }),
      h('div', { class: 'field' }, [h('label', { text: '排放口' }), outletSel]),
      h('div', { class: 'field' }, [h('label', { text: '设备' }), deviceSel]),
      h('div', { class: 'field' }, [h('label', { text: '指标' }), metricSel]),
      h('div', { class: 'field' }, [h('label', { text: '日期' }), dayInput]),
      h('div', { class: 'field' }, [h('label', { text: '月份' }), monthInput]),
      h('div', { class: 'field' }, [h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: '清空筛选', onclick: function () {
        state.readingsFilter = { outletId: '', deviceId: '', metric: '', day: '', month: '' };
        renderReadings();
      } })])
    ]));

    var c = clear(document.getElementById('content-readings'));
    var data;
    try { data = await api('GET', '/api/readings' + qs(state.readingsFilter)); }
    catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }
    state.readings = data;

    var tb = h('tbody');
    (data.rows || []).forEach(function (r) { tb.appendChild(readingRow(r)); });

    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '小时值清单' }),
        h('div', { class: 'btn-row' }, [
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新增监测数据', onclick: function () { openReadingForm(null); } })
        ])
      ]),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'section-note' }, [
          '共 ', h('b', { text: String(data.total) }), ' 条，已显示前 ', h('b', { text: String(data.returned) }), ' 条（总条数与已显示条数取自接口 total 与 returned）。'
        ]),
        h('div', { class: 'section-note' }, [
          '「折算后浓度（页面自算）」由本页按 实测 × (21 − 基准氧) / (21 − 氧含量) 计算，氧含量取接口 oxygen，缺失按基准氧处理；「接口折算浓度」直接显示接口 concentration。'
        ]),
        h('div', { class: 'table-wrap' }, h('table', { id: 'tableReadings' }, [
          h('thead', {}, h('tr', {}, [
            h('th', { text: '排放口' }), h('th', { text: '设备' }), h('th', { text: '指标' }), h('th', { text: '时刻' }),
            h('th', { text: '数值' }), h('th', { text: '标记' }), h('th', { text: '来源' }), h('th', { text: '登记人' }),
            h('th', { text: '是否计入' }), h('th', { text: '折算后浓度（页面自算）' }), h('th', { text: '接口折算浓度' }),
            h('th', { text: '当时氧含量' }), h('th', { text: '当时流量' }), h('th', { text: '操作' })
          ])),
          tb
        ]))
      ])
    ]));
  }

  function openReadingForm(reading) {
    var fields = [
      { name: 'outletId', label: '排放口', type: 'select', options: state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; }) },
      { name: 'deviceId', label: '设备', type: 'select', options: state.devices.map(function (d) { return { value: d.id, label: d.code + '（' + d.metric + '）' }; }) },
      { name: 'metric', label: '指标', type: 'select', options: METRICS },
      { name: 'at', label: '时刻（YYYY-MM-DD HH:00:00）' },
      { name: 'value', label: '数值', type: 'number' },
      { name: 'flag', label: '标记', type: 'select', options: FLAGS },
      { name: 'source', label: '来源', type: 'select', options: SOURCES },
      { name: 'operator', label: '登记人' },
      { name: 'remark', label: '备注', full: true }
    ];
    var defaults = reading || {
      outletId: state.outlets.length ? state.outlets[0].id : '',
      deviceId: state.devices.length ? state.devices[0].id : '',
      metric: 'COD', at: (state.month || '2026-09') + '-01 08:00:00', value: '', flag: '有效', source: '自动', operator: '', remark: ''
    };
    var form = buildForm(fields, defaults);
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var raw = collectForm(form);
      var payload = {
        at: raw.at, flag: raw.flag, source: raw.source, remark: raw.remark,
        value: raw.value === '' ? undefined : Number(raw.value)
      };
      if (!reading) {
        payload.outletId = raw.outletId;
        payload.deviceId = raw.deviceId;
        payload.metric = raw.metric;
        payload.operator = raw.operator;
      } else {
        payload.operator = undefined;
      }
      if (payload.value === undefined) delete payload.value;
      if (payload.operator === undefined) delete payload.operator;
      var p = reading ? api('PATCH', '/api/readings/' + reading.id, payload) : api('POST', '/api/readings', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(reading ? '监测数据已修改' : '监测数据已新增'); }).catch(showError);
    });
    openModal(reading ? '修改监测数据' : '新增监测数据', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  /* ================= 核算与报表 ================= */
  function summaryCard(sum, metric) {
    var row = metricOf(sum.rows, metric);
    var st = sum.settings || {};
    var cells = [
      ['月均', fmt(row.monthAverage)],
      ['月总量(吨)', fmt(row.monthTotalTons, 4)],
      ['季度总量 COD(吨)', fmt(sum.quarterTotalCod, 4)],
      ['季度许可量 COD(吨)', fmt(sum.permitCodTons, 4)],
      ['年累计 COD(吨)', fmt(sum.accumulatedCodTons, 4)],
      ['年许可量 COD(吨)', fmt(sum.annualPermitCodTons, 4)],
      ['超标天数', textOf(row.exceedDaysCount)],
      ['超标小时数', textOf(row.exceedHours)],
      ['限值', textOf(row.limit)],
      ['超标判定', row.exceeded ? '超标' : '达标'],
      ['年累计氨氮(吨)', fmt(sum.accumulatedAmmoniaTons, 4)],
      ['年许可量氨氮(吨)', fmt(st.annualPermitAmmoniaTons, 4)]
    ];
    var grid = h('div', { class: 'summary-grid' });
    cells.forEach(function (p) {
      var cls = '';
      if (p[0] === '超标判定') cls = p[1] === '超标' ? ' num-danger' : ' num-ok';
      grid.appendChild(h('div', { class: 'summary-cell' }, [
        h('div', { class: 'k', text: p[0] }),
        h('div', { class: 'v' + cls, text: p[1] })
      ]));
    });
    return grid;
  }

  function hourlyTable(rows) {
    var tb = h('tbody');
    (rows || []).forEach(function (r) {
      tb.appendChild(h('tr', { class: 'row' }, [
        h('td', { class: 'nowrap', text: r.at }),
        h('td', { class: 'mono', text: textOf(r.hour) }),
        h('td', { class: 'mono', text: textOf(r.value) }),
        h('td', { text: r.source }),
        h('td', {}, h('span', { class: 'tag ' + (r.flag === '有效' ? 'tag-ok' : 'tag-danger'), text: r.flag })),
        h('td', { text: textOf(r.deviceCode) }),
        h('td', {}, statusTag(r.deviceStatus, '正常')),
        h('td', { class: 'mono', text: textOf(r.oxygen) }),
        h('td', { class: 'mono', text: textOf(r.flow) }),
        h('td', { text: r.counted ? '计入' : (r.stopped ? '不计入（停产/停用）' : '不计入') }),
        h('td', { class: 'mono', text: textOf(r.concentration) })
      ]));
    });
    return h('table', { class: 'mini-table' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '时刻' }), h('th', { text: '小时' }), h('th', { text: '数值' }), h('th', { text: '来源' }),
        h('th', { text: '标记' }), h('th', { text: '设备' }), h('th', { text: '设备状态' }),
        h('th', { text: '氧含量' }), h('th', { text: '流量' }), h('th', { text: '是否计入' }), h('th', { text: '接口折算浓度' })
      ])),
      tb
    ]);
  }

  function dailyRow(d, metric) {
    return expandableRow([
      h('td', { class: 'nowrap', text: d.day }),
      h('td', { class: 'mono', text: textOf(d.countedHours) }),
      h('td', { class: 'mono', text: textOf(d.imputedHours) }),
      h('td', { class: 'mono', text: fmt(d.average) }),
      h('td', { class: 'mono', text: textOf(d.limit) }),
      h('td', {}, d.valid
        ? h('span', { class: 'tag ' + (d.exceed ? 'tag-danger' : 'tag-ok'), text: d.exceed ? '超标' : '达标' })
        : h('span', { class: 'tag tag-warn', text: '不计入' })),
      h('td', { class: 'mono', text: fmt(d.flowTotal, 1) }),
      h('td', { class: 'sub', text: d.invalidReason || '' })
    ], function () {
      var wrap = h('div');
      wrap.appendChild(h('div', { class: 'section-note', text: d.day + ' · ' + metric + ' 逐小时明细（共 ' + ((d.rows || []).length) + ' 小时）' }));
      wrap.appendChild(h('div', { class: 'table-wrap' }, hourlyTable(d.rows)));
      return wrap;
    });
  }

  async function reportDetailNode(id) {
    var rep = await api('GET', '/api/reports/' + id);
    var box = h('div');
    box.appendChild(h('div', { class: 'section-note' }, [
      h('b', { text: '单位：' }), rep.plant ? ((rep.plant.code || '') + ' ' + (rep.plant.name || '')) : '—',
      '　', h('b', { text: '期间：' }), rep.period, '　', h('b', { text: '月份：' }), rep.month
    ]));
    var outs = rep.outlets || [];
    if (!outs.length) box.appendChild(h('div', { class: 'empty', text: '该单位本月没有排放口数据' }));
    outs.forEach(function (os) {
      var ob = h('div', { class: 'detail-block' });
      ob.appendChild(h('h3', { text: (os.outlet ? (os.outlet.code + ' ' + os.outlet.name) : '排放口') + ' 汇总' }));
      var t = h('table', { class: 'mini-table' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '指标' }), h('th', { text: '月均' }), h('th', { text: '月总量(吨)' }), h('th', { text: '超标天数' }),
          h('th', { text: '超标小时' }), h('th', { text: '限值' }), h('th', { text: '超标' })
        ])),
        (function () {
          var tb = h('tbody');
          (os.rows || []).forEach(function (r) {
            tb.appendChild(h('tr', { class: 'row' }, [
              h('td', { text: r.metric }), h('td', { class: 'mono', text: fmt(r.monthAverage) }),
              h('td', { class: 'mono', text: fmt(r.monthTotalTons, 4) }), h('td', { class: 'mono', text: textOf(r.exceedDaysCount) }),
              h('td', { class: 'mono', text: textOf(r.exceedHours) }), h('td', { class: 'mono', text: textOf(r.limit) }),
              h('td', {}, h('span', { class: 'tag ' + (r.exceeded ? 'tag-danger' : 'tag-ok'), text: r.exceeded ? '超标' : '达标' }))
            ]));
          });
          return tb;
        })()
      ]);
      ob.appendChild(t);

      var dailyBlock = h('div', { class: 'detail-block' });
      dailyBlock.appendChild(h('h3', { text: '逐日明细' }));
      var holder = h('div', { class: 'empty', text: '加载中…' });
      dailyBlock.appendChild(holder);
      ob.appendChild(dailyBlock);
      box.appendChild(ob);

      api('GET', '/api/outlets/' + os.outlet.id + '/daily' + qs({ month: rep.month })).then(function (dd) {
        clear(holder);
        MAIN_METRICS.forEach(function (m) {
          var series = (dd.metrics || {})[m] || [];
          holder.appendChild(h('div', { class: 'section-note', text: m + ' 逐日（' + series.length + ' 天）' }));
          if (!series.length) { holder.appendChild(h('div', { class: 'empty', text: '本月没有 ' + m + ' 数据' })); return; }
          var tb = h('tbody');
          series.forEach(function (d) {
            tb.appendChild(h('tr', { class: 'row' }, [
              h('td', { class: 'nowrap', text: d.day }), h('td', { class: 'mono', text: textOf(d.countedHours) }),
              h('td', { class: 'mono', text: textOf(d.imputedHours) }), h('td', { class: 'mono', text: fmt(d.average) }),
              h('td', { class: 'mono', text: textOf(d.limit) }),
              h('td', {}, d.valid
                ? h('span', { class: 'tag ' + (d.exceed ? 'tag-danger' : 'tag-ok'), text: d.exceed ? '超标' : '达标' })
                : h('span', { class: 'tag tag-warn', text: '不计入' })),
              h('td', { class: 'mono', text: fmt(d.flowTotal, 1) }),
              h('td', { class: 'sub', text: d.invalidReason || '' })
            ]));
          });
          holder.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' }, [
            h('thead', {}, h('tr', {}, [
              h('th', { text: '日期' }), h('th', { text: '有效小时数' }), h('th', { text: '补录小时数' }),
              h('th', { text: '日均' }), h('th', { text: '限值' }), h('th', { text: '是否超标' }), h('th', { text: '当日流量合计' }), h('th', { text: '说明' })
            ])),
            tb
          ])));
        });
      }).catch(function (e) { holder.textContent = '逐日明细加载失败：' + e.message; });
    });
    return box;
  }

  function reportRow(r) {
    var statusSel = sel(REPORT_STATUS.map(function (s) { return { value: s, label: s }; }), r.status, null);
    statusSel.addEventListener('click', function (e) { e.stopPropagation(); });
    statusSel.addEventListener('change', function (e) {
      e.stopPropagation();
      api('PATCH', '/api/reports/' + r.id, { status: statusSel.value }).then(function () {
        return afterMutation('报表状态已改为 ' + statusSel.value);
      }).catch(function (err) { showError(err); statusSel.value = r.status; });
    });
    var actions = actionsCell([
      statusSel,
      actionBtn('改备注', function () { openReportEdit(r); })
    ]);
    return expandableRow([
      h('td', { text: r.period }),
      h('td', {}, statusTag(r.status, '已上报')),
      h('td', { text: textOf(r.submittedAt) }),
      h('td', { text: textOf(r.submittedBy) }),
      h('td', { text: textOf(r.remark) }),
      actions
    ], function () { return reportDetailNode(r.id); });
  }

  function openReportForm() {
    var fields = [
      { name: 'plantId', label: '排污单位', type: 'select', options: state.plants.map(function (p) { return { value: p.id, label: p.code + ' ' + p.name }; }) },
      { name: 'period', label: '期间（YYYY-MM）', type: 'month' },
      { name: 'status', label: '状态', type: 'select', options: REPORT_STATUS },
      { name: 'submittedBy', label: '上报人' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, { plantId: state.plants.length ? state.plants[0].id : '', period: state.month || '', status: '草稿' });
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '新建报表' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      api('POST', '/api/reports', payload).then(function () { closeModal(); return afterMutation('报表已新建'); }).catch(showError);
    });
    openModal('新建报表', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  function openReportEdit(r) {
    var fields = [
      { name: 'status', label: '状态', type: 'select', options: REPORT_STATUS },
      { name: 'submittedAt', label: '上报时刻' },
      { name: 'submittedBy', label: '上报人' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, r);
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      api('PATCH', '/api/reports/' + r.id, payload).then(function () { closeModal(); return afterMutation('报表已更新'); }).catch(showError);
    });
    openModal('修改报表', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  async function renderAccounting() {
    if (!state.accounting.outletId && state.outlets.length) state.accounting.outletId = state.outlets[0].id;
    if (!state.accounting.month) state.accounting.month = state.month;

    var f = clear(document.getElementById('filters-accounting'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '核算对象' }),
      h('div', { class: 'field' }, [h('label', { text: '排放口' }),
        sel(state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; }),
          state.accounting.outletId, function (v) { state.accounting.outletId = v; renderAccounting(); })]),
      h('div', { class: 'field' }, [h('label', { text: '月份' }),
        (function () {
          var mi = h('input', { type: 'month' });
          mi.value = state.accounting.month;
          mi.addEventListener('change', function () { state.accounting.month = mi.value; renderAccounting(); });
          return mi;
        })()]),
      h('div', { class: 'field' }, [h('label', { text: '指标' }),
        sel(MAIN_METRICS.map(function (m) { return { value: m, label: m }; }), state.accounting.metric,
          function (v) { state.accounting.metric = v; renderAccounting(); })])
    ]));

    var c = clear(document.getElementById('content-accounting'));
    if (!state.accounting.outletId) { c.appendChild(h('div', { class: 'empty', text: '没有可选排放口' })); return; }
    var month = state.accounting.month || state.month;
    var metric = state.accounting.metric || 'COD';

    var sum, daily;
    try {
      var out = await Promise.all([
        api('GET', '/api/outlets/' + state.accounting.outletId + '/summary' + qs({ month: month })),
        api('GET', '/api/outlets/' + state.accounting.outletId + '/daily' + qs({ month: month, metric: metric }))
      ]);
      sum = out[0]; daily = out[1];
    } catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }

    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: (sum.outlet ? (sum.outlet.code + ' ' + sum.outlet.name) : '排放口') + ' 汇总' }),
        h('span', { class: 'sub', text: (sum.plant ? (sum.plant.code + ' ' + sum.plant.name) : '') + ' · ' + month + ' · ' + metric })
      ]),
      h('div', { class: 'card-body' }, summaryCard(sum, metric))
    ]));

    var series = (daily.metrics || {})[metric] || [];
    var dailyTb = h('tbody');
    series.forEach(function (d) { dailyTb.appendChild(dailyRow(d, metric)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: metric + ' 逐日明细' }),
        h('span', { class: 'sub', text: '共 ' + series.length + ' 天（点某天展开逐小时明细）' })
      ]),
      h('div', { class: 'table-wrap' }, h('table', { id: 'tableDaily' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '日期' }), h('th', { text: '有效小时数' }), h('th', { text: '补录小时数' }), h('th', { text: '日均' }),
          h('th', { text: '限值' }), h('th', { text: '是否超标' }), h('th', { text: '当日流量合计' }), h('th', { text: '说明' })
        ])),
        dailyTb
      ]))
    ]));

    var reportTb = h('tbody');
    state.reports.forEach(function (r) { reportTb.appendChild(reportRow(r)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '报表' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + state.reports.length + ' 张（点行展开详情）' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新建报表', onclick: openReportForm })
        ])
      ]),
      h('div', { class: 'table-wrap' }, h('table', { id: 'tableReports' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '期间' }), h('th', { text: '状态' }), h('th', { text: '上报时刻' }), h('th', { text: '上报人' }),
          h('th', { text: '备注' }), h('th', { text: '操作' })
        ])),
        reportTb
      ]))
    ]));
  }

  /* ================= 对外提供 ================= */
  function checkItem(label, checked, onChange) {
    var input = h('input', { type: 'checkbox' });
    input.checked = !!checked;
    input.addEventListener('change', function () { onChange(input.checked); });
    return h('label', { class: 'check-item' }, [input, h('span', { text: label })]);
  }

  function kvList(pairs) {
    var dl = h('dl', { class: 'kv-list' });
    pairs.forEach(function (p) {
      dl.appendChild(h('dt', { text: p[0] }));
      dl.appendChild(h('dd', { text: p[1] }));
    });
    return dl;
  }

  function scopeText(scope) {
    return (scope.outletCodes || []).join('、') + ' · ' + (scope.metrics || []).join('、')
      + ' · ' + (scope.from || '不限') + ' 至 ' + (scope.to || '不限');
  }

  function shareScopePayload() {
    return {
      outletIds: Object.keys(state.share.outlets).filter(function (id) { return state.share.outlets[id]; }),
      metrics: Object.keys(state.share.metrics).filter(function (m) { return state.share.metrics[m]; }),
      from: state.share.from.trim(),
      to: state.share.to.trim()
    };
  }

  function verifyResultNode(v) {
    var box = h('div');
    box.appendChild(h('div', { class: 'verify-box' + (v.consistent ? '' : ' is-bad') }, [
      h('div', {}, [
        h('b', { text: v.consistent ? '一致性校验通过：' : '一致性校验不通过：' }),
        '按批次冻结的范围与脱敏规则版本重新生成，条数 ' + v.rowCountNow + '/' + v.rowCount + '，校验值 ' + (v.checksumNow === v.checksum ? '一致' : '不一致')
      ]),
      h('div', { class: 'mono', text: '批次校验值 ' + v.checksum.slice(0, 16) + '… / 重算 ' + v.checksumNow.slice(0, 16) + '…' })
    ]));
    box.appendChild(h('div', { class: 'verify-box' + (v.caliberChanged ? ' is-warn' : '') }, [
      '口径版本：批次 ' + v.caliberVersion + ' / 当前 ' + v.caliberVersionNow + (v.caliberChanged ? '（口径已变化，重算结果可能与批次不同）' : '（一致）'),
      '；脱敏规则版本：批次 ' + v.maskVersion + ' / 当前 ' + v.maskVersionNow
    ]));
    var a = v.alignment || {};
    var alignBox = h('div', { class: 'verify-box' + ((a.missing || (a.drifted || []).length) ? ' is-bad' : '') }, [
      h('b', { text: '与内部口径对齐核查：' }),
      '共 ' + a.total + ' 行，对齐 ' + a.aligned + ' 行，内部找不到 ' + a.missing + ' 行，有出入 ' + (a.drifted || []).length + ' 行'
    ]);
    if ((a.drifted || []).length) {
      var ul = h('ul');
      a.drifted.forEach(function (d) { ul.appendChild(h('li', { text: (d['行'] || '') + '：' + (d['问题'] || '') })); });
      alignBox.appendChild(ul);
    }
    box.appendChild(alignBox);
    return box;
  }

  function batchDetailNode(id) {
    return api('GET', '/api/share/batches/' + id).then(function (d) {
      var box = h('div');
      box.appendChild(h('div', { class: 'detail-block' }, [
        h('h3', { text: '批次要素' }),
        kvList([
          ['批次号', d.id],
          ['导出时刻', d.createdAt],
          ['操作人', d.operator],
          ['范围', scopeText(d.scope)],
          ['口径版本', d.caliberVersion],
          ['脱敏规则版本', d.maskVersion],
          ['数据条数', String(d.rowCount)],
          ['校验值', d.checksum]
        ])
      ]));
      var caliberPairs = Object.keys(d.caliberSnapshot || {}).map(function (k) { return [k, d.caliberSnapshot[k]]; });
      caliberPairs.push(['脱敏说明', d.maskDescription || '']);
      box.appendChild(h('div', { class: 'detail-block' }, [
        h('h3', { text: '口径说明快照（随数据一起给出的内容）' }),
        kvList(caliberPairs)
      ]));
      var mappingBlocks = h('div');
      [['单位编号映射', (d.mapping || {}).plants], ['设备编号映射', (d.mapping || {}).devices]].forEach(function (pair) {
        var entries = Object.keys(pair[1] || {});
        var tb = h('tbody');
        entries.forEach(function (k) {
          tb.appendChild(h('tr', { class: 'row' }, [h('td', { text: k }), h('td', { class: 'mono', text: pair[1][k] })]));
        });
        mappingBlocks.appendChild(h('div', { class: 'detail-block' }, [
          h('h3', { text: pair[0] + '（' + entries.length + '）' }),
          entries.length
            ? h('table', { class: 'mini-table' }, [h('thead', {}, h('tr', {}, [h('th', { text: '内部编号' }), h('th', { text: '对外别名' })])), tb])
            : h('div', { class: 'empty', text: '该规则下此字段不替换' })
        ]));
      });
      mappingBlocks.appendChild(h('div', { class: 'detail-block' }, [
        h('h3', { text: '数据编号映射' }),
        h('div', { text: '共 ' + Object.keys((d.mapping || {}).readings || {}).length + ' 条（逐条映射留档，用于与内部数据对齐核查）' })
      ]));
      var wrap = h('div');
      wrap.appendChild(h('div', { class: 'section-note', text: '以下为内部留档，不随文件对外。' }));
      wrap.appendChild(mappingBlocks);
      box.appendChild(wrap);
      return box;
    });
  }

  function batchRow(b) {
    var actions = actionsCell([
      actionBtn('下载文件', function () { window.open('/api/share/batches/' + b.id + '/file', '_blank'); }),
      actionBtn('二次校验', function () {
        api('POST', '/api/share/batches/' + b.id + '/verify').then(function (v) {
          openModal('二次校验 · ' + b.id, verifyResultNode(v), [
            h('button', { type: 'button', class: 'btn btn-ghost', text: '关闭', onclick: closeModal })
          ]);
        }).catch(showError);
      })
    ]);
    return expandableRow([
      h('td', {}, h('b', { text: b.id })),
      h('td', { class: 'nowrap', text: b.createdAt }),
      h('td', { text: b.operator }),
      h('td', { text: scopeText(b.scope) }),
      h('td', { class: 'mono', text: b.caliberVersion }),
      h('td', { class: 'mono', text: b.maskVersion }),
      h('td', { class: 'mono', text: String(b.rowCount) }),
      h('td', { class: 'mono', text: b.checksum.slice(0, 12) + '…', title: b.checksum }),
      actions
    ], function () { return batchDetailNode(b.id); });
  }

  async function renderShare() {
    var f = clear(document.getElementById('filters-share'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '对外提供' }),
      h('p', { class: 'hint', text: '公开清单选定范围后生成导出批次；口径说明与脱敏说明随数据一起给出；每次提供生成批次记录，可下载文件、可二次校验。' })
    ]));

    var c = clear(document.getElementById('content-share'));
    var catalog, batchesRes, mask;
    try {
      var out = await Promise.all([
        api('GET', '/api/share/catalog'),
        api('GET', '/api/share/batches'),
        api('GET', '/api/share/mask-rules')
      ]);
      catalog = out[0]; batchesRes = out[1]; mask = out[2];
    } catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }
    state.share.catalog = catalog;
    state.share.batches = batchesRes.batches || [];
    state.share.caliberLog = batchesRes.caliberLog || [];
    state.share.mask = mask;
    if (!Object.keys(state.share.outlets).length) {
      (catalog.outlets || []).forEach(function (o) { state.share.outlets[o.id] = true; });
    }
    if (!state.share.maskDraft) {
      var cur = (mask.rules || []).filter(function (r) { return r.maskVersion === mask.current; })[0];
      state.share.maskDraft = cur ? Object.assign({}, cur.rules) : {};
    }

    /* ---- 公开清单 ---- */
    var outletChecks = h('div', { class: 'check-grid' });
    (catalog.outlets || []).forEach(function (o) {
      outletChecks.appendChild(checkItem(o.code + ' ' + o.name + (o.status !== '运行' ? '（' + o.status + '）' : ''), state.share.outlets[o.id], function (v) {
        state.share.outlets[o.id] = v;
      }));
    });
    var metricChecks = h('div', { class: 'check-grid' });
    (catalog.metrics || []).forEach(function (m) {
      metricChecks.appendChild(checkItem(m, state.share.metrics[m], function (v) { state.share.metrics[m] = v; }));
    });
    var fromInput = h('input', { type: 'text', placeholder: '如 2026-09-01 或 2026-09-01 08:00:00' });
    fromInput.value = state.share.from;
    fromInput.addEventListener('change', function () { state.share.from = fromInput.value; });
    var toInput = h('input', { type: 'text', placeholder: '如 2026-09-30 或 2026-09-30 23:00:00' });
    toInput.value = state.share.to;
    toInput.addEventListener('change', function () { state.share.to = toInput.value; });
    var operatorInput = h('input', { type: 'text', placeholder: '批次要落到人' });
    operatorInput.value = state.share.operator;
    operatorInput.addEventListener('change', function () { state.share.operator = operatorInput.value; });

    var previewLine = h('div', { class: 'section-note' }, [
      '当前口径版本 ', h('b', { text: catalog.caliberVersion }), '，脱敏规则版本 ', h('b', { text: catalog.maskVersion }),
      '；数据时刻范围 ' + (catalog.timeBounds.min || '—') + ' 至 ' + (catalog.timeBounds.max || '—') + '。'
    ]);
    if (state.share.preview) {
      var p = state.share.preview;
      previewLine.appendChild(h('div', {}, [
        '预览：范围内 ', h('b', { text: String(p.rowCount) }), ' 条，校验值 ', h('span', { class: 'mono', text: p.checksum.slice(0, 16) + '…' }),
        '（口径 ' + p.caliberVersion + ' / 脱敏 ' + p.maskVersion + '）'
      ]));
    }

    var previewBtn = h('button', {
      type: 'button', class: 'btn btn-sm btn-ghost', text: '预览范围',
      onclick: function () {
        state.share.from = fromInput.value; state.share.to = toInput.value;
        api('POST', '/api/share/preview', shareScopePayload()).then(function (p) {
          state.share.preview = p;
          renderShare();
        }).catch(showError);
      }
    });
    var createBtn = h('button', {
      type: 'button', class: 'btn btn-sm btn-accent', text: '生成导出批次',
      onclick: function () {
        state.share.from = fromInput.value; state.share.to = toInput.value; state.share.operator = operatorInput.value;
        var payload = shareScopePayload();
        payload.operator = state.share.operator.trim();
        api('POST', '/api/share/batches', payload).then(function (b) {
          state.share.preview = null;
          toast('批次 ' + b.id + ' 已生成（' + b.rowCount + ' 条）');
          renderShare();
        }).catch(showError);
      }
    });

    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '公开清单（选择对外提供的范围）' }),
        h('span', { class: 'sub', text: '口径说明与脱敏说明会随数据一起写进导出文件' })
      ]),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'field' }, [h('label', { text: '排放口' }), outletChecks]),
        h('div', { class: 'field' }, [h('label', { text: '指标' }), metricChecks]),
        h('div', { class: 'form-grid' }, [
          h('div', { class: 'field' }, [h('label', { text: '开始时刻（留空不限）' }), fromInput]),
          h('div', { class: 'field' }, [h('label', { text: '结束时刻（留空不限）' }), toInput]),
          h('div', { class: 'field' }, [h('label', { text: '操作人' }), operatorInput])
        ]),
        h('div', { class: 'btn-row' }, [previewBtn, createBtn]),
        previewLine
      ])
    ]));

    /* ---- 批次记录 ---- */
    var batchTb = h('tbody');
    state.share.batches.forEach(function (b) { batchTb.appendChild(batchRow(b)); });
    var batchCard = h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '批次记录' }),
        h('span', { class: 'sub', text: '共 ' + state.share.batches.length + ' 批（点行展开口径快照与内部对齐映射）' })
      ]),
      state.share.batches.length
        ? h('div', { class: 'table-wrap' }, h('table', { id: 'tableShareBatches' }, [
            h('thead', {}, h('tr', {}, [
              h('th', { text: '批次号' }), h('th', { text: '导出时刻' }), h('th', { text: '操作人' }), h('th', { text: '范围' }),
              h('th', { text: '口径版本' }), h('th', { text: '脱敏版本' }), h('th', { text: '数据条数' }), h('th', { text: '校验值' }), h('th', { text: '操作' })
            ])),
            batchTb
          ]))
        : h('div', { class: 'empty', text: '还没有对外提供过数据' })
    ]);
    if (state.share.caliberLog.length) {
      var logTb = h('tbody');
      state.share.caliberLog.forEach(function (l) {
        logTb.appendChild(h('tr', { class: 'row' }, [
          h('td', { class: 'mono', text: l.version }),
          h('td', { class: 'nowrap', text: l.firstUsedAt }),
          h('td', { text: '基准氧 ' + l.settings.oxygenBaseline + ' · 量程 ' + l.settings.rangeMin + '-' + l.settings.rangeMax
            + ' · 限值 COD ' + l.settings.codDailyLimit + '/氨氮 ' + l.settings.ammoniaDailyLimit
            + ' · 补录上限 ' + l.settings.maxImputeHoursPerDay + 'h' })
        ]));
      });
      batchCard.appendChild(h('div', { class: 'card-body' }, [
        h('h3', { text: '口径版本留痕（每版口径首次对外使用的时刻与设置）' }),
        h('table', { class: 'mini-table' }, [
          h('thead', {}, h('tr', {}, [h('th', { text: '口径版本' }), h('th', { text: '首次使用时刻' }), h('th', { text: '当时设置摘要' })])),
          logTb
        ])
      ]));
    }
    c.appendChild(batchCard);

    /* ---- 脱敏规则 ---- */
    var maskForm = h('div', { class: 'form-grid' });
    (mask.fields || []).forEach(function (fd) {
      var select = h('select', { dataset: { field: 'mask_' + fd.field } });
      (mask.actions || []).forEach(function (a) {
        select.appendChild(h('option', { value: a.action, text: a.label + '（' + a.action + '）' }));
      });
      select.value = state.share.maskDraft[fd.field] || 'drop';
      select.addEventListener('change', function () { state.share.maskDraft[fd.field] = select.value; });
      maskForm.appendChild(h('div', { class: 'field' }, [h('label', { text: fd.label }), select]));
    });
    var maskNoteInput = h('input', { type: 'text', placeholder: '为什么改规则，留一句话' });
    maskNoteInput.value = state.share.maskNote;
    maskNoteInput.addEventListener('change', function () { state.share.maskNote = maskNoteInput.value; });
    var maskOpInput = h('input', { type: 'text', placeholder: '规则改动要留痕到人' });
    maskOpInput.value = state.share.maskOperator;
    maskOpInput.addEventListener('change', function () { state.share.maskOperator = maskOpInput.value; });
    maskForm.appendChild(h('div', { class: 'field' }, [h('label', { text: '改动说明' }), maskNoteInput]));
    maskForm.appendChild(h('div', { class: 'field' }, [h('label', { text: '操作人' }), maskOpInput]));

    var saveMaskBtn = h('button', {
      type: 'button', class: 'btn btn-sm btn-accent', text: '保存为新版本',
      onclick: function () {
        state.share.maskNote = maskNoteInput.value; state.share.maskOperator = maskOpInput.value;
        api('POST', '/api/share/mask-rules', {
          rules: state.share.maskDraft,
          note: state.share.maskNote.trim(),
          createdBy: state.share.maskOperator.trim()
        }).then(function (r) {
          state.share.maskDraft = null;
          toast('脱敏规则已保存为 ' + r.maskVersion);
          renderShare();
        }).catch(showError);
      }
    });

    var maskHistoryTb = h('tbody');
    (mask.rules || []).forEach(function (r) {
      var ruleText = (mask.fields || []).map(function (fd) {
        var act = (mask.actions || []).filter(function (a) { return a.action === r.rules[fd.field]; })[0];
        return fd.label + '·' + (act ? act.label : r.rules[fd.field]);
      }).join('、');
      maskHistoryTb.appendChild(h('tr', { class: 'row' }, [
        h('td', {}, h('b', { text: r.maskVersion }), r.maskVersion === mask.current ? [' ', h('span', { class: 'tag tag-ok', text: '现行' })] : null),
        h('td', { class: 'nowrap', text: r.createdAt || '—' }),
        h('td', { text: r.createdBy }),
        h('td', { text: ruleText }),
        h('td', { text: textOf(r.note) }),
        h('td', { class: 'mono', text: String(r.batchCount) })
      ]));
    });

    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '脱敏规则（现行 ' + mask.current + '）' }),
        h('span', { class: 'sub', text: '别名替换后内部仍可按规则版本对齐核查；规则只增不改，改动留痕' })
      ]),
      h('div', { class: 'card-body' }, [
        maskForm,
        h('div', { class: 'btn-row' }, [saveMaskBtn]),
        h('div', { class: 'section-note', text: '说明：「替换为别名」按规则盐值单向生成，同一版本下同一对象别名固定；「剔除」的字段不出现在导出文件里。' })
      ]),
      h('div', { class: 'table-wrap' }, h('table', { id: 'tableMaskRules' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '版本' }), h('th', { text: '改动时刻' }), h('th', { text: '操作人' }),
          h('th', { text: '规则内容' }), h('th', { text: '改动说明' }), h('th', { text: '引用批次数' })
        ])),
        maskHistoryTb
      ]))
    ]));
  }

  /* ================= 设置 ================= */
  function openSettings() {
    var s = state.settings || {};
    var fields = [
      { name: 'oxygenBaseline', label: '基准氧含量', type: 'number' },
      { name: 'rangeMax', label: '量程上限', type: 'number' },
      { name: 'maxImputeHoursPerDay', label: '单日补录上限（小时）', type: 'number' },
      { name: 'codDailyLimit', label: 'COD 日限值', type: 'number' },
      { name: 'ammoniaDailyLimit', label: '氨氮日限值', type: 'number' },
      { name: 'hourlyExceedCountLimit', label: '小时超标次数', type: 'number' },
      { name: 'annualPermitCodTons', label: '年许可 COD（吨）', type: 'number' },
      { name: 'annualPermitAmmoniaTons', label: '年许可氨氮（吨）', type: 'number' }
    ];
    var form = buildForm(fields, s);
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存设置' });
    save.addEventListener('click', function () {
      var raw = collectForm(form);
      var payload = {};
      Object.keys(raw).forEach(function (k) {
        var n = Number(raw[k]);
        payload[k] = isFinite(n) && raw[k] !== '' ? n : raw[k];
      });
      api('PATCH', '/api/settings', payload).then(function (res) {
        state.settings = res;
        if (state.summary) state.summary.settings = res;
        closeModal();
        toast('设置已保存');
        switchView(state.view);
      }).catch(showError);
    });
    openModal('设置', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  /* ================= 初始化 ================= */
  document.querySelectorAll('#tabs .tab').forEach(function (t) {
    t.addEventListener('click', function () { switchView(t.dataset.view); });
  });
  document.getElementById('settingsBtn').addEventListener('click', openSettings);

  async function init() {
    try {
      await loadAll();
      document.getElementById('todayText').textContent = state.today || '—';
      switchView('overview');
    } catch (e) {
      showError(e);
      document.getElementById('todayText').textContent = '—';
    }
  }
  init();
})();
