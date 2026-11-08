"use strict";
// 専門医・学会の期限管理 — LIFF ページ。
// 前半は表示ロジック（純粋関数。Node のテストから読む）、後半は画面（ブラウザでだけ動く）。
// 鍵・個人情報はこのファイルに書かない。鍵は URL のクエリ k で受け取り、GAS 側で照合する。

var DEFAULT_API = "https://script.google.com/macros/s/AKfycbxXOGdyCBI2dHdrIqcpK7AOyPQZFQ9OWvj2yHP_QkQirzCA9cE3596xsQat5W4Nr_SHjQ/exec";

// ---------------------------------------------------------------- 表示ロジック（純粋関数）

/** ?k=…&liff=…&api=… と、LIFF が畳んだ ?liff.state=%3Fk%3D… の両方を読む */
function readQuery(search) {
  var params = new URLSearchParams(search || "");
  var state = params.get("liff.state");
  if (state) {
    var inner = new URLSearchParams(state.charAt(0) === "?" ? state.slice(1) : state);
    inner.forEach(function (v, k) { if (!params.has(k)) params.set(k, v); });
  }
  return { k: params.get("k") || "", liff: params.get("liff") || "", api: params.get("api") || "" };
}

function parseYmd(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function dayDiff(fromYmd, toYmd) {
  var a = parseYmd(fromYmd), b = parseYmd(toYmd);
  if (!a || !b) return null;
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}

/** 判定する日: 終了日があり開始日が過ぎていれば終了日、それ以外は開始日 */
function targetYmd(row, today) {
  if (!parseYmd(row.開始日)) return null;
  if (row.終了日 && parseYmd(row.終了日) && dayDiff(row.開始日, today) >= 0) return row.終了日;
  return row.開始日;
}

function labelOf(row) {
  return row.名称 + (row["確定/推定"] === "推定" ? "（推定）" : "");
}

function withDays(row, today) {
  var t = targetYmd(row, today);
  var copy = {};
  Object.keys(row).forEach(function (k) { copy[k] = row[k]; });
  copy.target = t;
  copy.daysLeft = t ? dayDiff(today, t) : null;
  copy.label = labelOf(row);
  copy.inProgress = !!(t && t === row.終了日 && row.終了日 !== row.開始日);
  return copy;
}

/** 今日以降 horizonDays 以内の日付を、判定する日の順に */
function upcomingDates(dates, today, horizonDays) {
  return dates.map(function (d) { return withDays(d, today); })
    .filter(function (d) { return d.daysLeft !== null && d.daysLeft >= 0 && d.daysLeft <= horizonDays; })
    .sort(function (a, b) { return a.daysLeft - b.daysLeft; });
}

/** 過ぎた日付（新しい順） */
function pastDates(dates, today) {
  return dates.map(function (d) { return withDays(d, today); })
    .filter(function (d) { return d.daysLeft !== null && d.daysLeft < 0; })
    .sort(function (a, b) { return b.daysLeft - a.daysLeft; });
}

/** 開始日のない・読めない行 */
function undatedRows(dates) {
  return dates.filter(function (d) { return !parseYmd(d.開始日); });
}

/** 親の順で、子を付ける */
function groupRequirements(reqs) {
  var parents = reqs.filter(function (r) { return !r.親要件id; });
  return parents.map(function (p) {
    return { parent: p, children: reqs.filter(function (r) { return r.親要件id === p.id; }) };
  });
}

var DONE = { "済": true, "不要": true };

/** 資格ごとのカード */
function credentialCards(creds, reqs, dates, today) {
  var upcoming = upcomingDates(dates, today, 3650);
  return creds.map(function (c) {
    var parents = reqs.filter(function (r) { return r.資格id === c.id && r.derived && r.derived.isParent; });
    var done = parents.filter(function (r) { return DONE[r.derived.status]; }).length;
    var next = null;
    for (var i = 0; i < upcoming.length; i++) { if (upcoming[i].資格id === c.id) { next = upcoming[i]; break; } }
    return { cred: c, total: parents.length, done: done, rate: parents.length ? done / parents.length : 0, unmetCount: parents.length - done, next: next };
  });
}

/** "3/5回" / "3.5/4年" / 数値なしは状態 */
function statusLabel(req) {
  var target = req.目標値 === "" || req.目標値 === null || req.目標値 === undefined ? null : Number(req.目標値);
  if (target !== null && !isNaN(target)) {
    var cur = req.derived && req.derived.current !== null && req.derived.current !== undefined ? req.derived.current : 0;
    return cur + "/" + req.目標値 + (req.単位 || "");
  }
  return req.derived ? req.derived.status : (req.状態 || "未");
}

function nextStatus(current) {
  if (current === "未") return "進行中";
  if (current === "進行中") return "済";
  return "未";
}

if (typeof module !== "undefined") {
  module.exports = { readQuery, upcomingDates, pastDates, undatedRows, groupRequirements, credentialCards, statusLabel, nextStatus, labelOf, targetYmd };
}

// ---------------------------------------------------------------- 画面（ブラウザでだけ動く）

if (typeof document !== "undefined") (function () {
  var KINDS = ["申請開始", "申請締切", "エントリー締切", "要件期限", "会費期限", "会場予約", "試験", "結果発表", "認定日", "講習", "学術集会", "演題締切", "抄録締切", "更新期限", "届出", "公式確認", "その他"];
  var REPEATS = ["", "毎年", "2年ごと", "5年ごと"];
  var state = { api: "", key: "", data: null, view: "home", credId: "", editId: "", dateForm: null, busy: false, error: "" };
  var root = document.getElementById("app");

  // ---- 小さな道具
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), attrs[k]);
      else if (k === "checked" || k === "disabled" || k === "open") { if (attrs[k]) e.setAttribute(k, ""); }
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c === null || c === undefined) return; e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function md(ymd) { var d = parseYmd(ymd); return d ? (d.getMonth() + 1) + "/" + d.getDate() : "日付なし"; }
  function ymdWithYear(ymd) { var d = parseYmd(ymd); return d ? d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() : "日付なし"; }
  function daysText(n) { return n === 0 ? "今日" : n < 0 ? (-n) + " 日前" : "あと " + n + " 日"; }
  function credName(id) { var c = (state.data.credentials || []).filter(function (x) { return x.id === id; })[0]; return c ? c.名称 : ""; }
  function num(v, fallback) { var n = Number(v); return v === "" || v === null || v === undefined || isNaN(n) ? fallback : n; }
  function horizon() { return num(state.data.settings.表示日数, 90); }

  // ---- API
  function apiGet() {
    return fetch(state.api + "?action=all&k=" + encodeURIComponent(state.key)).then(function (r) { return r.json(); });
  }
  function apiPost(body) {
    body.k = state.key;
    return fetch(state.api, { method: "POST", body: JSON.stringify(body) }).then(function (r) { return r.json(); });
  }
  function load() {
    state.busy = true; state.error = ""; render();
    return apiGet().then(function (res) {
      state.busy = false;
      if (!res.ok) { state.error = res.error === "forbidden" ? "鍵が合いません。LINE のメッセージのリンクから開き直してください" : "読み込みに失敗しました: " + res.error; render(); return; }
      state.data = res; render();
    }).catch(function (e) { state.busy = false; state.error = "読み込みに失敗しました（" + e.message + "）"; render(); });
  }
  function submit(body) {
    state.busy = true; state.error = ""; render();
    return apiPost(body).then(function (res) {
      if (!res.ok) { state.busy = false; state.error = res.error || "保存に失敗しました"; render(); return false; }
      state.editId = ""; state.dateForm = null;
      return load().then(function () { return true; });
    }).catch(function (e) { state.busy = false; state.error = "保存に失敗しました（" + e.message + "）"; render(); return false; });
  }

  // ---- 共通の部品
  function header() {
    var tabs = [["home", "ホーム"], ["dates", "日付"], ["settings", "設定"]].map(function (t) {
      return el("button", { class: "tab" + (state.view === t[0] ? " active" : ""), onclick: function () { state.view = t[0]; state.editId = ""; state.dateForm = null; state.error = ""; render(); }, text: t[1] });
    });
    return el("header", {}, [el("h1", { text: "資格・学会の期限" }), el("nav", {}, tabs)]);
  }
  function errorBox() { return state.error ? el("p", { class: "error", text: state.error }) : null; }
  function busyBox() { return state.busy ? el("p", { class: "busy", text: "通信中…" }) : null; }
  function kindTag(row) { return el("span", { class: "tag", text: row.種別 }); }
  function dateLine(d, onclick) {
    var left = el("div", { class: "line-main" }, [
      el("div", { class: "line-title" + (d["確定/推定"] === "推定" ? " estimated" : ""), text: d.label }),
      el("div", { class: "line-sub" }, [kindTag(d), d.資格id ? el("span", { class: "muted", text: credName(d.資格id) }) : null,
        el("span", { class: "muted", text: (d.inProgress ? "受付中・締切 " : "") + ymdWithYear(d.target || d.開始日) })]),
    ]);
    var right = el("div", { class: "line-days" + (d.daysLeft !== null && d.daysLeft <= 7 ? " soon" : ""), text: d.daysLeft === null ? "日付なし" : daysText(d.daysLeft) });
    return el("div", { class: "line" + (onclick ? " clickable" : ""), onclick: onclick }, [left, right]);
  }

  // ---- ホーム
  function viewHome() {
    var d = state.data;
    var cards = credentialCards(d.credentials, d.requirements, d.dates, d.today).map(function (c) {
      var pct = Math.round(c.rate * 100);
      return el("div", { class: "card clickable", onclick: function () { state.view = "cred"; state.credId = c.cred.id; state.editId = ""; render(); } }, [
        el("div", { class: "card-head" }, [el("div", { class: "card-title", text: c.cred.名称 }), el("div", { class: "muted", text: (c.cred.種別 || "") + " " + c.cred.目標年度 + " 年度" })]),
        el("div", { class: "bar" }, [el("div", { class: "bar-fill", style: "width:" + pct + "%" })]),
        el("div", { class: "card-foot" }, [
          el("span", { text: "達成 " + c.done + "/" + c.total }),
          el("span", { class: c.unmetCount ? "warn" : "ok", text: c.unmetCount ? "足りない " + c.unmetCount + " 件" : "要件はそろっています" }),
        ]),
        c.next ? el("div", { class: "muted small", text: "次: " + c.next.label + "（" + md(c.next.target) + "・" + daysText(c.next.daysLeft) + "）" }) : null,
      ]);
    });
    var up = upcomingDates(d.dates, d.today, horizon());
    return el("main", {}, [
      el("section", {}, cards),
      el("section", {}, [el("h2", { text: "これから " + horizon() + " 日" }),
        up.length ? el("div", {}, up.map(function (x) { return dateLine(x, function () { state.view = "dates"; state.dateForm = formFromRow(x); render(); }); })) : el("p", { class: "muted", text: "この期間の日付はありません" })]),
    ]);
  }

  // ---- 資格の画面
  function reqRow(r, hasChildren) {
    var editing = state.editId === r.id;
    var st = r.derived ? r.derived.status : "未";
    var head = el("div", { class: "req-head clickable", onclick: function () { state.editId = editing ? "" : r.id; state.error = ""; render(); } }, [
      el("span", { class: "badge s-" + st, text: st }),
      el("span", { class: "req-text" + (r["確定/推定"] === "推定" ? " estimated" : ""), text: r.内容 }),
      el("span", { class: "req-val", text: statusLabel(r) }),
    ]);
    var kids = [head];
    if (r.対象期間 || r.期限) kids.push(el("div", { class: "muted small", text: (r.対象期間 ? "対象 " + r.対象期間 + " " : "") + (r.期限 ? "期限 " + r.期限 : "") }));
    if (editing) kids.push(reqEditor(r, hasChildren));
    return el("div", { class: "req" }, kids);
  }
  function reqEditor(r, hasChildren) {
    var memo = el("textarea", { rows: "2", placeholder: "根拠・メモ（証明書の有無など）" });
    memo.value = r["根拠・メモ"] || "";
    var fields = [];
    var payload = function () { return { op: "updateRequirement", id: r.id, "根拠・メモ": memo.value }; };
    var target = num(r.目標値, null);
    if (r.起算日 || (r.区分 === "会員" && r.単位 === "年")) {
      var start = el("input", { type: "date" }); start.value = r.起算日 || "";
      fields.push(el("label", {}, ["起算日（入会日など）", start]));
      var base = payload; payload = function () { var p = base(); p.起算日 = start.value; return p; };
    } else if (target !== null && !hasChildren) {
      var cur = el("input", { type: "number", inputmode: "decimal", step: "any" }); cur.value = r.derived && r.derived.current !== null ? r.derived.current : (r.現在値 || 0);
      var plus = el("button", { type: "button", class: "secondary", text: "＋1", onclick: function () { cur.value = String(num(cur.value, 0) + 1); } });
      fields.push(el("label", {}, ["現在値（目標 " + r.目標値 + (r.単位 || "") + "）", el("div", { class: "row" }, [cur, plus])]));
      var base2 = payload; payload = function () { var p = base2(); p.現在値 = cur.value; return p; };
    } else if (!hasChildren) {
      var st = r.derived ? r.derived.status : (r.状態 || "未");
      var cycle = el("button", { type: "button", class: "secondary", text: "状態: " + st + " → " + nextStatus(st), onclick: function () { st = nextStatus(st); cycle.textContent = "状態: " + st + " →" + " " + nextStatus(st); } });
      var skip = el("button", { type: "button", class: "secondary", text: "不要にする", onclick: function () { st = "不要"; cycle.textContent = "状態: 不要"; } });
      fields.push(el("div", { class: "row" }, [cycle, skip]));
      var base3 = payload; payload = function () { var p = base3(); p.状態 = st; return p; };
    } else {
      fields.push(el("p", { class: "muted small", text: "この項目の状態は内訳から自動で決まります" }));
    }
    fields.push(el("label", {}, ["根拠・メモ", memo]));
    if (r.出典URL) fields.push(el("a", { href: r.出典URL, target: "_blank", rel: "noopener", class: "small", text: "出典を開く" }));
    fields.push(el("div", { class: "row" }, [
      el("button", { type: "button", text: "保存", disabled: state.busy, onclick: function () { submit(payload()); } }),
      el("button", { type: "button", class: "secondary", text: "閉じる", onclick: function () { state.editId = ""; render(); } }),
    ]));
    return el("div", { class: "editor" }, fields);
  }
  function viewCred() {
    var d = state.data;
    var cred = d.credentials.filter(function (c) { return c.id === state.credId; })[0];
    if (!cred) { state.view = "home"; return viewHome(); }
    var reqs = d.requirements.filter(function (r) { return r.資格id === cred.id; });
    var groups = groupRequirements(reqs);
    var card = credentialCards([cred], d.requirements, d.dates, d.today)[0];
    var list = groups.map(function (g) {
      var hasChildren = g.children.length > 0;
      if (!hasChildren) return reqRow(g.parent, false);
      return el("details", { open: g.parent.derived && !DONE[g.parent.derived.status] }, [
        el("summary", {}, [reqRow(g.parent, true)]),
        el("div", { class: "children" }, g.children.map(function (c) { return reqRow(c, false); })),
      ]);
    });
    var credDates = upcomingDates(d.dates, d.today, 3650).filter(function (x) { return x.資格id === cred.id; });
    return el("main", {}, [
      el("button", { class: "secondary back", text: "← ホーム", onclick: function () { state.view = "home"; render(); } }),
      el("h2", { text: cred.名称 }),
      el("p", { class: "muted small", text: (cred["学会・機関"] || "") + "　目標 " + cred.目標年度 + " 年度　達成 " + card.done + "/" + card.total + (cred.要件確認日 ? "　要件の確認日 " + cred.要件確認日 : "") }),
      cred.メモ ? el("p", { class: "muted small", text: cred.メモ }) : null,
      cred.公式URL ? el("a", { href: cred.公式URL, target: "_blank", rel: "noopener", class: "small", text: "公式ページを開く" }) : null,
      el("section", {}, [el("h3", { text: "要件" })].concat(list)),
      el("section", {}, [el("h3", { text: "この資格の日付" })].concat(credDates.length ? credDates.map(function (x) { return dateLine(x, function () { state.view = "dates"; state.dateForm = formFromRow(x); render(); }); }) : [el("p", { class: "muted", text: "なし" })])),
    ]);
  }

  // ---- 日付の画面
  function formFromRow(row) {
    return { id: row.id, 資格id: row.資格id || "", 種別: row.種別 || "その他", 名称: row.名称 || "", 開始日: row.開始日 || "", 終了日: row.終了日 || "",
      "確定/推定": row["確定/推定"] || "確定", 出典URL: row.出典URL || "", メモ: row.メモ || "", 要件確認: row.要件確認 === "する", 繰り返し: row.繰り返し || "" };
  }
  function emptyForm() { return formFromRow({ id: "", 種別: "演題締切", "確定/推定": "確定" }); }
  function select(options, value, labels) {
    var s = el("select", {});
    options.forEach(function (o, i) { var opt = el("option", { value: o, text: labels ? labels[i] : (o === "" ? "（なし）" : o) }); if (o === value) opt.setAttribute("selected", ""); s.appendChild(opt); });
    return s;
  }
  function dateForm() {
    var f = state.dateForm;
    var name = el("input", { type: "text", placeholder: "例: JDDW 2027 演題締切" }); name.value = f.名称;
    var kind = select(KINDS, f.種別);
    var credIds = [""].concat(state.data.credentials.map(function (c) { return c.id; }));
    var cred = select(credIds, f.資格id, credIds.map(function (id) { return id ? credName(id) : "（資格に紐づけない）"; }));
    var start = el("input", { type: "date" }); start.value = f.開始日;
    var end = el("input", { type: "date" }); end.value = f.終了日;
    var sure = select(["確定", "推定"], f["確定/推定"]);
    var check = el("input", { type: "checkbox", checked: f.要件確認 });
    var rep = select(REPEATS, f.繰り返し);
    var memo = el("textarea", { rows: "2" }); memo.value = f.メモ;
    var url = el("input", { type: "url", placeholder: "https://" }); url.value = f.出典URL;
    var payload = function () {
      return { op: "upsertDate", id: f.id || undefined, 名称: name.value, 種別: kind.value, 資格id: cred.value, 開始日: start.value, 終了日: end.value,
        "確定/推定": sure.value, 要件確認: check.checked ? "する" : "", 繰り返し: rep.value, メモ: memo.value, 出典URL: url.value };
    };
    return el("div", { class: "editor" }, [
      el("h3", { text: f.id ? "日付を編集" : "日付を追加" }),
      el("label", {}, ["名称", name]), el("label", {}, ["種別", kind]), el("label", {}, ["資格", cred]),
      el("label", {}, ["日付（期間なら開始日）", start]), el("label", {}, ["終了日（期間のあるものだけ）", end]),
      el("label", {}, ["確定 / 推定", sure]),
      el("label", { class: "inline" }, [check, " 近づいたら足りない要件も知らせる（申請締切など）"]),
      el("label", {}, ["繰り返し", rep]), el("label", {}, ["メモ", memo]), el("label", {}, ["出典 URL", url]),
      el("div", { class: "row" }, [
        el("button", { type: "button", text: "保存", disabled: state.busy, onclick: function () { submit(payload()); } }),
        f.id ? el("button", { type: "button", class: "danger", text: "削除", disabled: state.busy, onclick: function () { if (window.confirm("「" + f.名称 + "」を削除します。よろしいですか？")) submit({ op: "deleteDate", id: f.id }); } }) : null,
        el("button", { type: "button", class: "secondary", text: "キャンセル", onclick: function () { state.dateForm = null; render(); } }),
      ]),
    ]);
  }
  function viewDates() {
    var d = state.data;
    var up = upcomingDates(d.dates, d.today, 3650);
    var past = pastDates(d.dates, d.today);
    var undated = undatedRows(d.dates);
    var open = function (x) { return function () { state.dateForm = formFromRow(x); state.error = ""; render(); window.scrollTo(0, 0); }; };
    return el("main", {}, [
      state.dateForm ? dateForm() : el("button", { text: "＋ 日付を追加", onclick: function () { state.dateForm = emptyForm(); render(); } }),
      el("section", {}, [el("h2", { text: "これから" })].concat(up.length ? up.map(function (x) { return dateLine(x, open(x)); }) : [el("p", { class: "muted", text: "なし" })])),
      undated.length ? el("section", {}, [el("h2", { text: "日付が読めない行" })].concat(undated.map(function (x) { return dateLine(withDays(x, d.today), open(x)); }))) : null,
      el("details", {}, [el("summary", { text: "過ぎた日付（" + past.length + "）" }), el("div", {}, past.map(function (x) { return dateLine(x, open(x)); }))]),
    ]);
  }

  // ---- 設定
  function viewSettings() {
    var s = state.data.settings;
    var th = el("input", { type: "text" }); th.value = s.しきい値 || "60,30,14,7,3,1,0";
    var lead = el("input", { type: "number" }); lead.value = s.要件アラート先行日数 || 90;
    var monthly = el("input", { type: "checkbox", checked: String(s.月初まとめ).toUpperCase() !== "FALSE" });
    var time = el("input", { type: "time" }); time.value = s.通知時刻 || "07:30";
    var days = el("input", { type: "number" }); days.value = s.表示日数 || 90;
    return el("main", {}, [
      el("h2", { text: "設定" }),
      el("div", { class: "editor" }, [
        el("label", {}, ["知らせる日（締切の何日前。カンマ区切り）", th]),
        el("label", {}, ["足りない要件を知らせ始める日数（締切の何日前）", lead]),
        el("label", { class: "inline" }, [monthly, " 毎月 1 日にまとめを送る"]),
        el("label", {}, ["知らせる時刻", time]),
        el("label", {}, ["ホームに出す日数", days]),
        el("div", { class: "row" }, [el("button", { type: "button", text: "保存", disabled: state.busy, onclick: function () {
          submit({ op: "updateSettings", しきい値: th.value, 要件アラート先行日数: lead.value, 月初まとめ: monthly.checked ? "TRUE" : "FALSE", 通知時刻: time.value, 表示日数: days.value });
        } })]),
      ]),
      el("p", { class: "muted small", text: "今日の日付（サーバー）: " + state.data.today }),
    ]);
  }

  // ---- 描画
  function render() {
    clear(root);
    root.appendChild(header());
    if (!state.key) { root.appendChild(el("main", {}, [el("p", { class: "error", text: "LINE のメッセージのリンクから開いてください（鍵がありません）" })])); return; }
    if (!state.api) { root.appendChild(el("main", {}, [el("p", { class: "error", text: "接続先（API）が設定されていません" })])); return; }
    var b = busyBox(); if (b) root.appendChild(b);
    var e = errorBox(); if (e) root.appendChild(e);
    if (!state.data) return;
    var view = state.view === "cred" ? viewCred() : state.view === "dates" ? viewDates() : state.view === "settings" ? viewSettings() : viewHome();
    root.appendChild(view);
  }

  // ---- 起動
  function start() {
    var q = readQuery(location.search);
    var init = Promise.resolve();
    if (q.liff && typeof liff !== "undefined") {
      init = liff.init({ liffId: q.liff }).catch(function () { /* LIFF 外でも動く */ });
    }
    init.then(function () {
      var q2 = readQuery(location.search);
      state.key = q2.k || q.k;
      state.api = q2.api || q.api || DEFAULT_API;
      render();
      if (state.key && state.api) load();
    });
  }
  start();
})();
