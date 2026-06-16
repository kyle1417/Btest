/* ============================================================
   安全员B证 刷题 App  —  纯前端逻辑
   依赖：window.QUESTION_BANK (js/questions.js)
   持久化：localStorage
   ============================================================ */
(function () {
  "use strict";

  var BANK = window.QUESTION_BANK || [];
  var PAPERS = window.EXAM_PAPERS || {};
  var PAPER_Q = {};                       // 真题 id -> 题对象（扁平索引）
  Object.keys(PAPERS).forEach(function (y) {
    (PAPERS[y].questions || []).forEach(function (q) { PAPER_Q[q.id] = q; });
  });
  var TYPE_NAME = { single: "单选题", multiple: "多选题", judge: "判断题" };
  var LETTERS = "ABCDEFGHIJ";

  /* ---------- 存储 ---------- */
  var LS = {
    get: function (k, def) {
      try { var v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); }
      catch (e) { return def; }
    },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var K_WRONG = "sb_wrong", K_FAV = "sb_fav", K_PRACTICE = "sb_practice_progress";
  var K_SYNC = "sb_sync_code", K_UPDATED = "sb_updated_at";
  var K_PWRONG = "sb_paper_wrong";

  var wrongSet = new Set(LS.get(K_WRONG, []));
  var favSet = new Set(LS.get(K_FAV, []));
  var pWrongSet = new Set(LS.get(K_PWRONG, []));   // 真题独立错题集（id 为字符串）
  function saveWrong() { LS.set(K_WRONG, Array.from(wrongSet)); }
  function saveFav() { LS.set(K_FAV, Array.from(favSet)); }
  function savePWrong() { LS.set(K_PWRONG, Array.from(pWrongSet)); }

  /* ---------- 云同步 ---------- */
  var SYNC_API = "https://sync.pantao.online/sync/";
  var syncCode = LS.get(K_SYNC, "") || "";
  var syncDebounce = null;

  function touch() { LS.set(K_UPDATED, Date.now()); scheduleSync(); }
  function scheduleSync() {
    if (!syncCode) return;
    clearTimeout(syncDebounce);
    syncDebounce = setTimeout(function () { doSync(true, false); }, 2500);
  }
  function localData() {
    return {
      wrong: Array.from(wrongSet),
      fav: Array.from(favSet),
      paperWrong: Array.from(pWrongSet),
      practice: LS.get(K_PRACTICE, null),
      updatedAt: LS.get(K_UPDATED, 0) || 0
    };
  }
  // 整体「后写覆盖」：以 updatedAt 较新的一方为准，保证删除/清除能正确同步。
  // 适用场景：同一人在多台设备间轮流使用（每台设备进入时先拉取再编辑）。
  function mergeData(local, remote) {
    remote = remote || {};
    var lU = local.updatedAt || 0, rU = remote.updatedAt || 0;
    if (rU > lU) {
      return {
        wrong: remote.wrong || [], fav: remote.fav || [],
        paperWrong: remote.paperWrong || [],
        practice: remote.practice || null, updatedAt: rU
      };
    }
    return {
      wrong: local.wrong || [], fav: local.fav || [],
      paperWrong: local.paperWrong || [],
      practice: local.practice || null, updatedAt: lU || Date.now()
    };
  }
  function applyData(d) {
    wrongSet = new Set(d.wrong || []);
    favSet = new Set(d.fav || []);
    pWrongSet = new Set(d.paperWrong || []);
    saveWrong(); saveFav(); savePWrong();
    if (d.practice) LS.set(K_PRACTICE, d.practice); else LS.del(K_PRACTICE);
    LS.set(K_UPDATED, d.updatedAt || Date.now());
  }
  function setSyncStatus(t) { var el = $("#syncStatus"); if (el) el.textContent = t; }

  /* ---------- 存档（最近 2 份，可回滚） ---------- */
  var SNAP_KEEP = 2, SNAP_MERGE_MS = 5 * 60 * 1000; // 距上一存档<5分钟则原地更新
  var lastSnaps = [];
  // 兼容旧格式（单个 blob）→ 转成一份存档
  function snapsFromRemote(remote) {
    if (!remote || typeof remote !== "object") return [];
    if (Array.isArray(remote.snapshots)) return remote.snapshots;
    if (remote.wrong || remote.fav || remote.paperWrong || remote.practice) {
      var u = remote.updatedAt || 0;
      return [{ at: u, updatedAt: u, wrong: remote.wrong || [], fav: remote.fav || [], paperWrong: remote.paperWrong || [], practice: remote.practice || null }];
    }
    return [];
  }
  function dataSig(d) {
    return JSON.stringify({
      w: (d.wrong || []).slice().sort(function (a, b) { return a - b; }),
      f: (d.fav || []).slice().sort(function (a, b) { return a - b; }),
      pw: (d.paperWrong || []).slice().sort(),
      p: d.practice || null
    });
  }
  function fmtTime(ms) {
    if (!ms) return "—";
    var d = new Date(ms), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function renderSnaps() {
    var box = $("#syncSnaps"); if (!box) return;
    if (!syncCode || !lastSnaps.length) { box.innerHTML = ""; return; }
    var html = "<div class='sync__snaptitle'>云端存档（点旧存档可恢复）</div>";
    lastSnaps.forEach(function (s, i) {
      var cur = i === 0;
      html += "<div class='sync__snap" + (cur ? " is-cur" : "") + "'" + (cur ? "" : " data-restore='" + i + "'") + ">" +
        "<span class='sync__snapdot'></span>" +
        "<span class='sync__snaptime'>" + fmtTime(s.at) + "</span>" +
        "<span class='sync__snapinfo'>错 " + (s.wrong || []).length + " · 藏 " + (s.fav || []).length + "</span>" +
        "<span class='sync__snaptag'>" + (cur ? "当前" : "恢复") + "</span>" +
        "</div>";
    });
    box.innerHTML = html;
  }
  function doSync(silent, manual) {
    if (!syncCode) return Promise.resolve();
    if (!silent) setSyncStatus("同步中…");
    return fetch(SYNC_API + encodeURIComponent(syncCode))
      .then(function (r) { return r.json(); })
      .then(function (remote) {
        var snaps = snapsFromRemote(remote);
        var cur = snaps[0] || null;
        var merged = mergeData(localData(), cur || {});
        applyData(merged);

        var now = Date.now();
        var changed = !cur || dataSig(merged) !== dataSig(cur);
        if (changed) {
          var newSnap = { at: now, updatedAt: merged.updatedAt, wrong: merged.wrong, fav: merged.fav, paperWrong: merged.paperWrong, practice: merged.practice };
          if (!cur) {
            snaps = [newSnap];
          } else {
            var rotate = manual || (now - (cur.at || 0) >= SNAP_MERGE_MS);
            snaps = rotate ? [newSnap].concat(snaps).slice(0, SNAP_KEEP)
                           : [newSnap].concat(snaps.slice(1)).slice(0, SNAP_KEEP);
          }
          lastSnaps = snaps;
          renderSnaps();
          return fetch(SYNC_API + encodeURIComponent(syncCode), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ snapshots: snaps })
          }).then(function () {
            refreshHome();
            setSyncStatus("已同步 · " + new Date().toLocaleTimeString());
          });
        }
        lastSnaps = snaps;
        renderSnaps();
        refreshHome();
        setSyncStatus("已同步 · " + new Date().toLocaleTimeString());
      })
      .catch(function (e) {
        if (!silent) setSyncStatus("同步失败：" + (e && e.message || "网络错误"));
      });
  }
  function restoreSnap(idx) {
    var s = lastSnaps[idx]; if (!s) return;
    if (!confirm("确定恢复到 " + fmtTime(s.at) + " 的记录吗？\n当前内容会被这份存档覆盖。")) return;
    applyData({ wrong: s.wrong, fav: s.fav, paperWrong: s.paperWrong, practice: s.practice, updatedAt: Date.now() });
    refreshHome();
    doSync(false, true); // 作为新的当前档推送（手动→必定生成新存档）
  }

  /* ---------- 工具 ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function byId(id) { return PAPER_Q[id] || BANK.find(function (q) { return q.id === id; }); }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    var s = a.slice().sort(), t = b.slice().sort();
    return s.every(function (v, i) { return v === t[i]; });
  }
  function answerText(q) {
    return q.answer.map(function (i) { return LETTERS[i] + "." + q.options[i]; }).join("  ");
  }
  function autoExplain(q) {
    if (q.explanation && q.explanation.trim()) return q.explanation.trim();
    if (q.type === "judge") return "正确答案：" + q.options[q.answer[0]];
    return "正确答案：" + answerText(q);
  }

  /* ---------- 视图路由 ---------- */
  var viewStack = [];
  function showView(name, opts) {
    $$(".view").forEach(function (v) { v.hidden = v.getAttribute("data-view") !== name; });
    opts = opts || {};
    if (!opts.silent) viewStack.push(name);
    $("#btnBack").hidden = (name === "home");
    window.scrollTo(0, 0);
  }
  function goBack() {
    if (quiz.timerId) { if (!confirm("退出当前作答？")) return; stopTimer(); }
    viewStack.pop();
    var prev = viewStack[viewStack.length - 1] || "home";
    if (prev === "quiz") prev = "home"; // 不回退进答题中途
    showView(prev, { silent: true });
    if (prev === "home") refreshHome();
  }
  $("#btnBack").addEventListener("click", goBack);

  document.addEventListener("click", function (e) {
    var go = e.target.closest("[data-go]");
    if (go) { route(go.getAttribute("data-go")); }
  });
  function route(name) {
    if (name === "practiceSetup") { showView("practiceSetup"); updatePracticeInfo(); }
    else if (name === "examSetup") { showView("examSetup"); updateExamInfo(); }
    else if (name === "wrongbook") openList("wrong");
    else if (name === "favbook") openList("fav");
    else if (name === "search") { showView("search"); $("#searchInput").focus(); }
    else if (name === "sync") openSync();
    else if (name === "papers") openPapers();
  }

  /* ---------- 历年真题 ---------- */
  function openPapers() {
    $("#topTitle").textContent = "历年真题";
    var box = $("#papersBox");
    var years = Object.keys(PAPERS).sort().reverse();
    var html = "";
    years.forEach(function (y) {
      var p = PAPERS[y], n = (p.questions || []).length;
      var cnt = { single: 0, multiple: 0, judge: 0 };
      p.questions.forEach(function (q) { cnt[q.type]++; });
      html += '<button class="paper-card" data-paper="' + y + '">' +
        '<span class="paper-card__year">' + y + '</span>' +
        '<span class="paper-card__body">' +
        '<span class="paper-card__name">' + escapeHtml(p.title) + '</span>' +
        '<span class="paper-card__desc">共 ' + n + ' 题 · 单选' + cnt.single + ' 多选' + cnt.multiple + ' 判断' + cnt.judge + ' · ' + (p.minutes || 100) + '分钟</span>' +
        '</span><span class="paper-card__go">›</span></button>';
    });
    html += '<button class="btn btn--ghost btn--block" id="btnPaperWrong">真题错题集（' + pWrongSet.size + '）</button>';
    box.innerHTML = html;
    $("#btnPaperWrong").addEventListener("click", openPaperWrong);
    showView("papers");
  }
  $("#papersBox").addEventListener("click", function (e) {
    var pc = e.target.closest("[data-paper]"); if (!pc) return;
    startPaper(pc.getAttribute("data-paper"));
  });
  function startPaper(year) {
    var p = PAPERS[year]; if (!p) return;
    var ids = p.questions.map(function (q) { return q.id; });
    startQuiz({
      mode: "exam", ids: ids, pos: 0,
      meta: { minutes: p.minutes || 100, score: p.score || { single: 1, multiple: 2, judge: 1 },
              paper: true, paperTitle: p.title }
    });
  }
  function openPaperWrong() {
    $("#topTitle").textContent = "真题错题集";
    var ids = Array.from(pWrongSet);
    var box = $("#listBox");
    if (!ids.length) {
      box.innerHTML = '<div class="list__empty">暂无真题错题</div>';
    } else {
      var html = '<button class="btn btn--primary btn--block" id="btnPracticePWrong">练习这些题（' + ids.length + '）</button>';
      ids.forEach(function (id) {
        var q = byId(id); if (!q) return;
        html += '<div class="qitem">' +
          '<div class="qitem__type">' + TYPE_NAME[q.type] + ' · ' + id + '</div>' +
          '<div class="qitem__stem">' + escapeHtml(q.question) + '</div>' +
          '<div class="qitem__ans">答案：' + (q.type === "judge" ? q.options[q.answer[0]] : answerText(q)) + '</div>' +
          '<div class="qitem__btns"><button class="btn btn--ghost" data-rmpwrong="' + id + '">移出错题</button></div>' +
          '</div>';
      });
      box.innerHTML = html;
      $("#btnPracticePWrong").addEventListener("click", function () {
        startQuiz({ mode: "practice", ids: ids.slice(), pos: 0, meta: { type: "paperwrong", order: "seq", paper: true } });
      });
    }
    showView("list");
  }

  /* ---------- 云同步界面 ---------- */
  function genCode() {
    var s = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", out = "";
    for (var i = 0; i < 8; i++) out += s[Math.floor(Math.random() * s.length)];
    return out;
  }
  function openSync() {
    $("#topTitle").textContent = "云同步";
    $("#syncCodeInput").value = syncCode || "";
    $("#btnSyncOff").hidden = !syncCode;
    setSyncStatus(syncCode ? "当前同步码：" + syncCode : "尚未启用，输入或生成一个同步码");
    renderSnaps();
    showView("sync");
    if (syncCode) doSync(true, false); // 进入时刷新存档显示
  }
  $("#syncSnaps").addEventListener("click", function (e) {
    var el = e.target.closest("[data-restore]"); if (!el) return;
    restoreSnap(+el.getAttribute("data-restore"));
  });
  $("#btnGenCode").addEventListener("click", function () {
    $("#syncCodeInput").value = genCode();
  });
  $("#btnSyncNow").addEventListener("click", function () {
    var code = $("#syncCodeInput").value.trim();
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) {
      alert("同步码需为 4-64 位字母、数字、下划线或连字符");
      return;
    }
    syncCode = code; LS.set(K_SYNC, code);
    $("#btnSyncOff").hidden = false;
    doSync(false, true);
  });
  $("#btnSyncOff").addEventListener("click", function () {
    syncCode = ""; LS.del(K_SYNC);
    clearTimeout(syncDebounce);
    lastSnaps = []; renderSnaps();
    $("#btnSyncOff").hidden = true;
    setSyncStatus("已停止同步");
    refreshHome();
  });

  /* ---------- 首页 ---------- */
  function refreshHome() {
    $("#homeStat").textContent = "共 " + BANK.length + " 题　单选/多选/判断";
    $("#wrongCount").textContent = wrongSet.size + " 题";
    $("#favCount").textContent = favSet.size + " 题";
    var sd = $("#syncCardDesc");
    if (sd) sd.textContent = syncCode ? "已开启 · " + syncCode : "PC/手机进度互通";
    $("#topTitle").textContent = "见安全，行致远";
  }

  $("#btnResetAll").addEventListener("click", function () {
    if (!confirm("确定清除全部进度、错题、收藏记录？")) return;
    wrongSet.clear(); favSet.clear();
    LS.del(K_WRONG); LS.del(K_FAV); LS.del(K_PRACTICE);
    touch();
    refreshHome();
    alert("已清除");
  });

  /* ---------- 通用 seg 选择器 ---------- */
  function bindSeg(id, onChange) {
    var box = $("#" + id);
    box.addEventListener("click", function (e) {
      var b = e.target.closest(".seg__btn"); if (!b) return;
      $$(".seg__btn", box).forEach(function (x) { x.classList.remove("is-active"); });
      b.classList.add("is-active");
      if (onChange) onChange(b.getAttribute("data-val"));
    });
  }
  function segVal(id) { var a = $("#" + id + " .is-active"); return a ? a.getAttribute("data-val") : null; }

  /* ============================================================
     练习模式
     ============================================================ */
  bindSeg("practiceType", updatePracticeInfo);
  bindSeg("practiceOrder");
  function practicePool() {
    var t = segVal("practiceType");
    return t === "all" ? BANK : BANK.filter(function (q) { return q.type === t; });
  }
  function updatePracticeInfo() {
    var n = practicePool().length;
    var saved = LS.get(K_PRACTICE, null);
    var info = "可练习 " + n + " 题";
    if (saved && $("#practiceResume").checked) info += "　·　上次练到第 " + (saved.pos + 1) + " 题";
    $("#practiceInfo").textContent = info;
  }
  $("#practiceResume").addEventListener("change", updatePracticeInfo);

  $("#btnStartPractice").addEventListener("click", function () {
    var pool = practicePool();
    if (!pool.length) { alert("该题型暂无题目"); return; }
    var order = segVal("practiceOrder");
    var resume = $("#practiceResume").checked;
    var saved = LS.get(K_PRACTICE, null);
    var ids, pos = 0;

    if (resume && saved && saved.type === segVal("practiceType") && saved.order === order && saved.ids) {
      ids = saved.ids; pos = saved.pos || 0;
    } else {
      ids = pool.map(function (q) { return q.id; });
      if (order === "random") ids = shuffle(ids);
    }
    startQuiz({
      mode: "practice", ids: ids, pos: pos,
      meta: { type: segVal("practiceType"), order: order }
    });
  });

  /* ============================================================
     考试模式
     ============================================================ */
  function countType(t) { return BANK.filter(function (q) { return q.type === t; }).length; }
  function updateExamInfo() {
    var s = +$("#examSingle").value || 0, m = +$("#examMultiple").value || 0, j = +$("#examJudge").value || 0;
    var total = s * 1 + m * 2 + j * 1;
    $("#examInfo").innerHTML = "共 " + (s + m + j) + " 题，满分 " + total + " 分（题库：单选" +
      countType("single") + " 多选" + countType("multiple") + " 判断" + countType("judge") + "）";
  }
  ["examSingle", "examMultiple", "examJudge"].forEach(function (id) {
    $("#" + id).addEventListener("input", updateExamInfo);
  });

  $("#btnStartExam").addEventListener("click", function () {
    var s = +$("#examSingle").value || 0, m = +$("#examMultiple").value || 0, j = +$("#examJudge").value || 0;
    var minutes = +$("#examMinutes").value || 0;
    if (s + m + j === 0) { alert("请至少设置一种题型的数量"); return; }
    if (s > countType("single") || m > countType("multiple") || j > countType("judge")) {
      alert("某题型设置数量超过题库现有数量"); return;
    }
    var pick = function (type, n) { return shuffle(BANK.filter(function (q) { return q.type === type; })).slice(0, n).map(function (q) { return q.id; }); };
    var ids = pick("single", s).concat(pick("multiple", m)).concat(pick("judge", j));
    startQuiz({
      mode: "exam", ids: ids, pos: 0,
      meta: { minutes: minutes, score: { single: 1, multiple: 2, judge: 1 } }
    });
  });

  /* ============================================================
     答题引擎（练习 + 考试通用）
     ============================================================ */
  var quiz = { mode: null, ids: [], pos: 0, answers: {}, submitted: {}, meta: {}, timerId: null, remain: 0 };

  function startQuiz(cfg) {
    quiz.mode = cfg.mode; quiz.ids = cfg.ids; quiz.pos = cfg.pos || 0;
    quiz.answers = {}; quiz.submitted = {}; quiz.meta = cfg.meta || {};
    $("#topTitle").textContent = quiz.meta.paperTitle ? quiz.meta.paperTitle
      : (cfg.mode === "exam" ? "模拟考试" : "练习模式");
    $("#qFav").style.display = quiz.meta.paper ? "none" : "";
    toggleNav(false);
    showView("quiz");

    var isExam = cfg.mode === "exam";
    $("#qTimer").hidden = !isExam;
    $("#btnFinishExam").hidden = !isExam;
    stopTimer();
    if (isExam && quiz.meta.minutes > 0) startTimer(quiz.meta.minutes * 60);

    renderQuestion();
  }

  function curQ() { return byId(quiz.ids[quiz.pos]); }

  function renderQuestion() {
    var q = curQ();
    $("#qIndex").textContent = quiz.pos + 1;
    $("#qTotal").textContent = quiz.ids.length;
    $("#qProgressFill").style.width = ((quiz.pos + 1) / quiz.ids.length * 100) + "%";
    $("#qFav").classList.toggle("is-on", favSet.has(q.id));

    var chosen = quiz.answers[q.id] || [];
    var submitted = !!quiz.submitted[q.id];
    var isExam = quiz.mode === "exam";

    var html = '<span class="qtype qtype--' + q.type + '">' + TYPE_NAME[q.type] +
      (q.type === "multiple" ? "（多选）" : "") + '</span>';
    html += '<div class="qstem"><span class="qid">' + q.id + '.</span>' + escapeHtml(q.question) + '</div>';

    q.options.forEach(function (opt, i) {
      var cls = "opt";
      if (submitted && !isExam) {
        if (q.answer.indexOf(i) > -1) cls += " is-correct";
        else if (chosen.indexOf(i) > -1) cls += " is-wrong";
        cls += " is-locked";
      } else if (chosen.indexOf(i) > -1) cls += " is-chosen";
      html += '<div class="' + cls + '" data-i="' + i + '">' +
        '<span class="opt__key">' + LETTERS[i] + '</span>' +
        '<span class="opt__txt">' + escapeHtml(opt) + '</span></div>';
    });
    $("#qCard").innerHTML = html;

    // 反馈（仅练习模式提交后显示）
    var fb = $("#qFeedback");
    if (submitted && !isExam) {
      var ok = sameSet(chosen, q.answer);
      fb.hidden = false;
      fb.className = "quiz__feedback " + (ok ? "ok" : "no");
      fb.innerHTML = '<div class="fb__title ' + (ok ? "ok" : "no") + '">' + (ok ? "✓ 回答正确" : "✗ 回答错误") + '</div>' +
        '<div class="fb__ans">正确答案：<b>' + (q.type === "judge" ? q.options[q.answer[0]] : answerText(q)) + '</b></div>' +
        (q.explanation && q.explanation.trim() ? '<div class="fb__exp">解析：' + escapeHtml(q.explanation.trim()) + '</div>' : '');
    } else {
      fb.hidden = true;
    }

    // 按钮文案
    var btn = $("#btnSubmitOrNext");
    $("#btnPrev").disabled = quiz.pos === 0;
    if (isExam) {
      btn.textContent = quiz.pos === quiz.ids.length - 1 ? "已是最后一题" : "下一题";
      btn.disabled = quiz.pos === quiz.ids.length - 1;
    } else {
      if (submitted) {
        btn.textContent = quiz.pos === quiz.ids.length - 1 ? "完成" : "下一题";
        btn.disabled = false;
      } else {
        btn.textContent = "提交";
        btn.disabled = chosen.length === 0;
      }
    }
  }

  /* ---------- 题号跳转面板 ---------- */
  function navStateClass(id, idx) {
    var cls = "qnav__cell";
    if (idx === quiz.pos) return cls + " is-cur";
    var chosen = quiz.answers[id] || [];
    if (quiz.mode !== "exam" && quiz.submitted[id]) {
      cls += sameSet(chosen, byId(id).answer) ? " is-right" : " is-wrong2";
    } else if (chosen.length) {
      cls += " is-ans";
    }
    return cls;
  }
  function renderNav() {
    var grid = $("#qNavGrid");
    grid.innerHTML = quiz.ids.map(function (id, idx) {
      return '<button class="' + navStateClass(id, idx) + '" data-jump="' + idx + '">' + (idx + 1) + '</button>';
    }).join("");
  }
  function toggleNav(force) {
    var nav = $("#qNav"), open = force != null ? force : nav.hidden;
    nav.hidden = !open;
    $("#qNavToggle").classList.toggle("is-open", open);
    if (open) renderNav();
  }
  $("#qNavToggle").addEventListener("click", function () { toggleNav(); });
  $("#qNavGrid").addEventListener("click", function (e) {
    var cell = e.target.closest("[data-jump]"); if (!cell) return;
    quiz.pos = +cell.getAttribute("data-jump");
    toggleNav(false);
    savePracticeProgress();
    renderQuestion();
  });

  // 选项点击
  $("#qCard").addEventListener("click", function (e) {
    var el = e.target.closest(".opt"); if (!el) return;
    var q = curQ();
    if (quiz.submitted[q.id] && quiz.mode !== "exam") return;
    var i = +el.getAttribute("data-i");
    var arr = quiz.answers[q.id] ? quiz.answers[q.id].slice() : [];
    if (q.type === "multiple") {
      var p = arr.indexOf(i); if (p > -1) arr.splice(p, 1); else arr.push(i);
    } else {
      arr = [i];
    }
    quiz.answers[q.id] = arr;
    // 单选/判断 + 考试模式 = 选了即记录；练习模式等提交
    renderQuestion();
  });

  // 提交 / 下一题
  $("#btnSubmitOrNext").addEventListener("click", function () {
    var q = curQ();
    var isExam = quiz.mode === "exam";
    if (!isExam && !quiz.submitted[q.id]) {
      // 练习：提交本题
      quiz.submitted[q.id] = true;
      var ok = sameSet(quiz.answers[q.id] || [], q.answer);
      if (!ok && !quiz.meta.paper) { wrongSet.add(q.id); saveWrong(); }
      savePracticeProgress();
      renderQuestion();
    } else {
      // 进入下一题 / 完成
      if (quiz.pos < quiz.ids.length - 1) { quiz.pos++; savePracticeProgress(); renderQuestion(); }
      else if (!isExam) { finishPractice(); }
    }
  });

  $("#btnPrev").addEventListener("click", function () {
    if (quiz.pos > 0) { quiz.pos--; savePracticeProgress(); renderQuestion(); }
  });

  // 收藏
  $("#qFav").addEventListener("click", function () {
    if (quiz.meta.paper) return;
    var q = curQ();
    if (favSet.has(q.id)) favSet.delete(q.id); else favSet.add(q.id);
    saveFav(); touch();
    $("#qFav").classList.toggle("is-on", favSet.has(q.id));
  });

  function savePracticeProgress() {
    if (quiz.mode !== "practice" || quiz.meta.paper) return;
    LS.set(K_PRACTICE, { type: quiz.meta.type, order: quiz.meta.order, ids: quiz.ids, pos: quiz.pos });
    touch();
  }

  function finishPractice() {
    var done = Object.keys(quiz.submitted).length;
    var correct = quiz.ids.filter(function (id) {
      return quiz.submitted[id] && sameSet(quiz.answers[id] || [], byId(id).answer);
    }).length;
    LS.del(K_PRACTICE);
    alert("本轮练习结束\n已答 " + done + " 题，正确 " + correct + " 题");
    showView("home", { silent: true }); viewStack = ["home"]; refreshHome();
    $("#topTitle").textContent = "见安全，行致远";
  }

  /* ---------- 计时器（考试） ---------- */
  function startTimer(sec) {
    quiz.remain = sec; updateTimer();
    quiz.timerId = setInterval(function () {
      quiz.remain--; updateTimer();
      if (quiz.remain <= 0) { stopTimer(); alert("考试时间到，自动交卷"); doFinishExam(); }
    }, 1000);
  }
  function stopTimer() { if (quiz.timerId) { clearInterval(quiz.timerId); quiz.timerId = null; } }
  function updateTimer() {
    var m = Math.floor(quiz.remain / 60), s = quiz.remain % 60;
    $("#qTimer").textContent = (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* ---------- 交卷 ---------- */
  $("#btnFinishExam").addEventListener("click", function () {
    var unanswered = quiz.ids.filter(function (id) { return !(quiz.answers[id] && quiz.answers[id].length); }).length;
    var msg = unanswered ? "还有 " + unanswered + " 题未作答，确定交卷？" : "确定交卷？";
    if (confirm(msg)) doFinishExam();
  });

  function doFinishExam() {
    stopTimer();
    var sc = quiz.meta.score, totalScore = 0, gotScore = 0;
    var byType = { single: { n: 0, c: 0 }, multiple: { n: 0, c: 0 }, judge: { n: 0, c: 0 } };
    var isPaper = !!quiz.meta.paper;
    var wrongList = [];
    quiz.ids.forEach(function (id) {
      var q = byId(id);
      byType[q.type].n++;
      totalScore += sc[q.type];
      var ok = sameSet(quiz.answers[id] || [], q.answer);
      if (ok) { byType[q.type].c++; gotScore += sc[q.type]; }
      else { wrongList.push(id); if (isPaper) pWrongSet.add(id); else wrongSet.add(id); }
    });
    if (isPaper) { savePWrong(); } else { saveWrong(); }
    touch();
    renderExamResult(gotScore, totalScore, byType, wrongList, isPaper);
    showView("examResult");
    $("#topTitle").textContent = "考试结果";
  }

  function renderExamResult(got, total, byType, wrongList, isPaper) {
    var pass = got >= total * 0.6;
    var html = '<div class="result__score ' + (pass ? "pass" : "fail") + '">' + got + '</div>' +
      '<div class="result__label">满分 ' + total + ' 分 · ' + (pass ? "合格 🎉" : "不合格") + '（60% 及格）</div>' +
      '<div class="result__meta">';
    ["single", "multiple", "judge"].forEach(function (t) {
      if (byType[t].n) html += '<div><b>' + byType[t].c + '/' + byType[t].n + '</b>' + TYPE_NAME[t] + '</div>';
    });
    html += '</div>';
    html += '<button class="btn btn--primary btn--block" id="btnReviewWrong">查看错题（' + wrongList.length + '）</button>';
    html += '<button class="btn btn--ghost btn--block" id="btnBackHome">返回首页</button>';
    $("#examResultBox").innerHTML = html;

    $("#btnReviewWrong").addEventListener("click", function () {
      if (!wrongList.length) { alert("全部答对，无错题"); return; }
      openListWith(wrongList, "本次错题", null,
        isPaper ? { type: "paperwrong", order: "seq", paper: true } : { type: "list", order: "seq" });
    });
    $("#btnBackHome").addEventListener("click", function () {
      viewStack = ["home"]; showView("home", { silent: true }); refreshHome();
      $("#topTitle").textContent = "见安全，行致远";
    });
  }

  /* ============================================================
     错题本 / 收藏夹 / 列表
     ============================================================ */
  function openList(kind) {
    var ids = kind === "wrong" ? Array.from(wrongSet) : Array.from(favSet);
    openListWith(ids, kind === "wrong" ? "错题本" : "收藏夹", kind);
  }
  function openListWith(ids, title, kind, practiceMeta) {
    $("#topTitle").textContent = title;
    var box = $("#listBox");
    if (!ids.length) {
      box.innerHTML = '<div class="list__empty">暂无题目</div>';
    } else {
      var html = '<button class="btn btn--primary btn--block" id="btnPracticeList">练习这些题（' + ids.length + '）</button>';
      ids.forEach(function (id) {
        var q = byId(id); if (!q) return;
        html += '<div class="qitem">' +
          '<div class="qitem__type">' + TYPE_NAME[q.type] + ' · 第' + q.id + '题</div>' +
          '<div class="qitem__stem">' + escapeHtml(q.question) + '</div>' +
          '<div class="qitem__ans">答案：' + (q.type === "judge" ? q.options[q.answer[0]] : answerText(q)) + '</div>' +
          '<div class="qitem__btns">' +
          (kind === "wrong" ? '<button class="btn btn--ghost" data-rmwrong="' + id + '">移出错题</button>' : '') +
          (kind === "fav" ? '<button class="btn btn--ghost" data-rmfav="' + id + '">取消收藏</button>' : '') +
          '</div></div>';
      });
      box.innerHTML = html;
      $("#btnPracticeList").addEventListener("click", function () {
        startQuiz({ mode: "practice", ids: ids.slice(), pos: 0, meta: practiceMeta || { type: "list", order: "seq" } });
      });
    }
    showView("list");
  }
  $("#listBox").addEventListener("click", function (e) {
    var rw = e.target.closest("[data-rmwrong]"), rf = e.target.closest("[data-rmfav]"), rpw = e.target.closest("[data-rmpwrong]");
    if (rw) { wrongSet.delete(+rw.getAttribute("data-rmwrong")); saveWrong(); touch(); openList("wrong"); }
    if (rf) { favSet.delete(+rf.getAttribute("data-rmfav")); saveFav(); touch(); openList("fav"); }
    if (rpw) { pWrongSet.delete(rpw.getAttribute("data-rmpwrong")); savePWrong(); touch(); openPaperWrong(); }
  });

  /* ============================================================
     搜索
     ============================================================ */
  var searchTimer = null;
  $("#searchInput").addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 200);
  });
  function runSearch() {
    var kw = $("#searchInput").value.trim();
    var box = $("#searchResult");
    if (!kw) { box.innerHTML = ""; return; }
    var hits = BANK.filter(function (q) {
      return q.question.indexOf(kw) > -1 || q.options.some(function (o) { return o.indexOf(kw) > -1; });
    }).slice(0, 50);
    if (!hits.length) { box.innerHTML = '<div class="search__empty">未找到相关题目</div>'; return; }
    box.innerHTML = hits.map(function (q) {
      return '<div class="qitem">' +
        '<div class="qitem__type">' + TYPE_NAME[q.type] + ' · 第' + q.id + '题</div>' +
        '<div class="qitem__stem">' + hl(q.question, kw) + '</div>' +
        '<div class="qitem__ans">答案：' + (q.type === "judge" ? q.options[q.answer[0]] : answerText(q)) + '</div>' +
        '</div>';
    }).join("");
  }
  function hl(text, kw) {
    return escapeHtml(text).split(escapeHtml(kw)).join('<mark>' + escapeHtml(kw) + '</mark>');
  }

  /* ---------- 安全 ---------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- 初始化 ---------- */
  viewStack = ["home"];
  refreshHome();
  updateExamInfo();
  if (syncCode) doSync(true, false); // 启动时静默拉取一次
})();
