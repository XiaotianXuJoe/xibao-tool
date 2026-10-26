/**
 * 红白喜报生成工具 - 前端单页逻辑
 * 流程: 模板管理 -> 上传原图 -> 触发生成(轮询进度) -> 结果勾选下载
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    navWork: $('navWork'),
    navHistory: $('navHistory'),
    navSettings: $('navSettings'),
    viewWork: $('viewWork'),
    viewHistory: $('viewHistory'),
    viewSettings: $('viewSettings'),
    setModel: $('setModel'),
    setBaseUrl: $('setBaseUrl'),
    setSize: $('setSize'),
    setConcurrency: $('setConcurrency'),
    setApiKey: $('setApiKey'),
    settingsStatus: $('settingsStatus'),
    btnSaveSettings: $('btnSaveSettings'),
    btnTestSettings: $('btnTestSettings'),
    btnResetSettings: $('btnResetSettings'),
    settingsTestResult: $('settingsTestResult'),
    btnRefreshHistory: $('btnRefreshHistory'),
    historyStatus: $('historyStatus'),
    historyList: $('historyList'),
    batchBar: $('batchBar'),
    batchNameInput: $('batchNameInput'),
    btnSaveBatchName: $('btnSaveBatchName'),
    batchNameStatus: $('batchNameStatus'),
    templateDrop: $('templateDrop'),
    originalsDrop: $('originalsDrop'),
    templatePreview: $('templatePreview'),
    btnPickTemplate: $('btnPickTemplate'),
    inputTemplate: $('inputTemplate'),
    templateStatus: $('templateStatus'),
    btnPickOriginals: $('btnPickOriginals'),
    inputOriginals: $('inputOriginals'),
    btnUpload: $('btnUpload'),
    uploadStatus: $('uploadStatus'),
    originalsList: $('originalsList'),
    inputCount: $('inputCount'),
    btnGenerate: $('btnGenerate'),
    promptInput: $('promptInput'),
    progressBox: $('progressBox'),
    progressFill: $('progressFill'),
    progressText: $('progressText'),
    failedList: $('failedList'),
    resultGroups: $('resultGroups'),
    btnSelectAll: $('btnSelectAll'),
    btnInvert: $('btnInvert'),
    selectedCount: $('selectedCount'),
    btnDownloadEach: $('btnDownloadEach'),
    btnDownload: $('btnDownload'),
    lightbox: $('lightbox'),
    lightboxImg: $('lightboxImg'),
    lightboxClose: $('lightboxClose'),
    lightboxPrev: $('lightboxPrev'),
    lightboxNext: $('lightboxNext'),
    lightboxCounter: $('lightboxCounter'),
  };

  var state = {
    batchId: null,
    pendingFiles: [],
    polling: null,
    defaultPrompt: '',
    renderedFiles: new Set(), // 已上屏的生成图 file 标识, 增量渲染去重
    groupEls: {},             // folder -> 分组 DOM 引用, 供增量追加
    slotEls: {},              // job.id+'#'+item.key -> 占位卡片元素, 保序原地替换
  };

  // ------------------------------------------------------------------ 工具
  function api(url, options) {
    return fetch(url, options).then(function (resp) {
      return resp.json().then(function (json) {
        if (!resp.ok) throw new Error(json.error || ('HTTP ' + resp.status));
        return json;
      });
    });
  }

  function currentPrompt() {
    var v = els.promptInput.value.trim();
    return v || state.defaultPrompt;
  }

  function setStatus(el, msg, isError) {
    el.textContent = msg || '';
    el.style.color = isError ? '#b3261e' : '';
  }

  function openLightbox(src) {
    els.lightboxImg.src = src;
    els.lightbox.classList.remove('hidden');
    updateGalleryNav(src);
  }

  // ------------------------------------------------------------------ 大图预览翻页
  /** 按 DOM 展示顺序收集结果区全部生成图 URL(实时, 含增量追加、排除已删除)。 */
  function collectGallery() {
    return Array.prototype.slice
      .call(els.resultGroups.querySelectorAll('.gen-item img'))
      .map(function (img) { return img.src; });
  }

  /** 刷新翻页按钮与页码; 单张或无匹配时隐藏翻页控件(如模板预览)。 */
  function updateGalleryNav(src) {
    var list = collectGallery();
    var idx = list.indexOf(src);
    if (idx === -1) {
      els.lightboxCounter.textContent = '';
      els.lightboxPrev.classList.add('hidden');
      els.lightboxNext.classList.add('hidden');
      return;
    }
    els.lightboxCounter.textContent = (idx + 1) + ' / ' + list.length;
    els.lightboxPrev.classList.toggle('hidden', list.length <= 1);
    els.lightboxNext.classList.toggle('hidden', list.length <= 1);
  }

  /** dir=1 下一张(左滑/右箭头), dir=-1 上一张(右滑/左箭头)。 */
  function stepLightbox(dir) {
    var list = collectGallery();
    var idx = list.indexOf(els.lightboxImg.src);
    if (idx === -1 || list.length === 0) return;
    var next = Math.max(0, Math.min(list.length - 1, idx + dir));
    if (next === idx) return;
    els.lightboxImg.src = list[next];
    updateGalleryNav(list[next]);
  }

  els.lightboxPrev.addEventListener('click', function (e) {
    e.stopPropagation();
    stepLightbox(-1);
  });
  els.lightboxNext.addEventListener('click', function (e) {
    e.stopPropagation();
    stepLightbox(1);
  });

  // 手机端左右滑动切换
  var touchStartX = null;
  els.lightbox.addEventListener('touchstart', function (e) {
    touchStartX = e.changedTouches[0].clientX;
  }, { passive: true });
  els.lightbox.addEventListener('touchend', function (e) {
    if (touchStartX === null) return;
    var dx = e.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(dx) < 50) return; // 短位移视为点按, 不翻页
    stepLightbox(dx < 0 ? 1 : -1);
  }, { passive: true });

  // 桌面端方向键支持
  document.addEventListener('keydown', function (e) {
    if (els.lightbox.classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') stepLightbox(-1);
    else if (e.key === 'ArrowRight') stepLightbox(1);
    else if (e.key === 'Escape') els.lightbox.classList.add('hidden');
  });

  // ------------------------------------------------------------------ 视图切换
  var VIEWS = ['work', 'history', 'settings'];
  function showView(view) {
    VIEWS.forEach(function (v) {
      var cap = v.charAt(0).toUpperCase() + v.slice(1);
      els['view' + cap].classList.toggle('hidden', v !== view);
      els['nav' + cap].classList.toggle('active', v === view);
    });
    if (view === 'history') loadHistory();
    if (view === 'settings') loadSettingsPage();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  els.navWork.addEventListener('click', function () { showView('work'); });
  els.navHistory.addEventListener('click', function () { showView('history'); });
  els.navSettings.addEventListener('click', function () { showView('settings'); });
  els.btnRefreshHistory.addEventListener('click', function () { loadHistory(); });

  // ------------------------------------------------------------------ 设置页
  function loadSettingsPage() {
    setStatus(els.settingsStatus, '加载中...');
    setStatus(els.settingsTestResult, '');
    api('/api/settings').then(function (s) {
      els.setModel.value = s.model || '';
      els.setBaseUrl.value = s.baseUrl || '';
      els.setSize.value = s.size || '2K';
      if (els.setSize.value !== (s.size || '2K')) els.setSize.value = '2K'; // 兼容历史非法值
      els.setConcurrency.value = s.concurrency || 6;
      els.setApiKey.value = '';
      els.setApiKey.placeholder = s.hasApiKey
        ? '当前已保存 ' + s.apiKeyMasked + '（留空表示不修改）'
        : '尚未配置，请输入 API Key';
      setStatus(
        els.settingsStatus,
        s.source === 'custom' ? '当前使用自定义设置（已保存到服务器）' : '当前使用服务器默认配置（.env）',
      );
    }).catch(function (e) {
      setStatus(els.settingsStatus, '设置加载失败：' + e.message, true);
    });
  }

  function collectSettingsForm() {
    var body = {
      model: els.setModel.value.trim(),
      baseUrl: els.setBaseUrl.value.trim(),
      size: els.setSize.value,
      concurrency: Math.max(1, Math.min(20, parseInt(els.setConcurrency.value, 10) || 6)),
    };
    if (els.setApiKey.value.trim()) body.apiKey = els.setApiKey.value.trim();
    return body;
  }

  els.btnSaveSettings.addEventListener('click', function () {
    els.btnSaveSettings.disabled = true;
    setStatus(els.settingsStatus, '保存中...');
    api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectSettingsForm()),
    }).then(function () {
      toast('设置已保存并生效 ✓');
      loadSettingsPage();
    }).catch(function (e) {
      setStatus(els.settingsStatus, '保存失败：' + e.message, true);
    }).finally(function () {
      els.btnSaveSettings.disabled = false;
    });
  });

  els.btnTestSettings.addEventListener('click', function () {
    els.btnTestSettings.disabled = true;
    els.btnTestSettings.textContent = '测试中（约30-60秒）…';
    setStatus(els.settingsTestResult, '正在用当前填写的配置发起真实生成请求验证，请稍候...');
    api('/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectSettingsForm()),
    }).then(function (r) {
      if (r.ok) {
        setStatus(
          els.settingsTestResult,
          '✓ 连接成功（模型 ' + r.model + '，耗时 ' + (r.elapsedMs / 1000).toFixed(1) + ' 秒）' + (r.note ? '：' + r.note : ''),
        );
      } else {
        setStatus(els.settingsTestResult, '✗ 连接失败：' + r.error, true);
      }
    }).catch(function (e) {
      setStatus(els.settingsTestResult, '✗ 测试请求失败：' + e.message, true);
    }).finally(function () {
      els.btnTestSettings.disabled = false;
      els.btnTestSettings.textContent = '测试连接';
    });
  });

  els.btnResetSettings.addEventListener('click', function () {
    if (!confirm('恢复为服务器 .env 中的默认配置？自定义设置将被清除。')) return;
    api('/api/settings', { method: 'DELETE' }).then(function () {
      toast('已恢复默认配置');
      loadSettingsPage();
    }).catch(function (e) {
      alert('恢复失败：' + e.message);
    });
  });

  function formatTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // ------------------------------------------------------------------ 历史归档
  function loadHistory() {
    setStatus(els.historyStatus, '加载中...');
    api('/api/batches').then(function (r) {
      var batches = r.batches || [];
      els.historyList.innerHTML = '';
      if (batches.length === 0) {
        setStatus(els.historyStatus, '暂无归档批次，先到工作台上传图片生成吧');
        return;
      }
      setStatus(els.historyStatus, '共 ' + batches.length + ' 个归档批次');
      batches.forEach(function (b) {
        els.historyList.appendChild(renderHistoryCard(b));
      });
    }).catch(function (e) {
      setStatus(els.historyStatus, '归档加载失败：' + e.message, true);
    });
  }

  function renderHistoryCard(b) {
    var card = document.createElement('div');
    card.className = 'history-card';

    if (b.cover) {
      var cover = document.createElement('img');
      cover.className = 'cover';
      cover.src = b.cover;
      cover.alt = b.name || b.batchId;
      cover.loading = 'lazy';
      cover.addEventListener('click', function () { openBatch(b.batchId); });
      card.appendChild(cover);
    } else {
      var ph = document.createElement('div');
      ph.className = 'cover-placeholder';
      ph.textContent = '暂无图片';
      card.appendChild(ph);
    }

    var info = document.createElement('div');
    info.className = 'info';

    var nameRow = document.createElement('div');
    nameRow.className = 'name-row';
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 50;
    nameInput.value = b.name || b.batchId;
    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-mini';
    saveBtn.textContent = '改名';
    saveBtn.addEventListener('click', function () {
      var name = nameInput.value.trim();
      if (!name) { alert('名称不能为空'); return; }
      saveBtn.disabled = true;
      api('/api/batches/' + encodeURIComponent(b.batchId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }),
      }).then(function () {
        saveBtn.textContent = '已保存 ✓';
        setTimeout(function () { saveBtn.textContent = '改名'; saveBtn.disabled = false; }, 1500);
      }).catch(function (e) {
        alert('重命名失败：' + e.message);
        saveBtn.disabled = false;
      });
    });
    nameRow.appendChild(nameInput);
    nameRow.appendChild(saveBtn);

    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = formatTime(b.createdAt) + ' · 原图 ' + b.originalsCount +
      ' 张 · 已生成 ' + b.generatedCount + ' 张';

    var btnRow = document.createElement('div');
    btnRow.className = 'history-btn-row';
    var openBtn = document.createElement('button');
    openBtn.className = 'btn btn-primary open-btn';
    openBtn.textContent = '打开继续生成';
    openBtn.addEventListener('click', function () { openBatch(b.batchId); });
    var delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger';
    delBtn.textContent = '删除';
    delBtn.title = '删除整个批次（原图与全部生成图）';
    delBtn.addEventListener('click', function () {
      if (!confirm('确定删除整个批次「' + (b.name || b.batchId) + '」？\n' +
        '该批次的 ' + b.originalsCount + ' 张原图和 ' + b.generatedCount +
        ' 张生成图将一并删除，不可恢复。')) return;
      delBtn.disabled = true;
      api('/api/batches/' + encodeURIComponent(b.batchId), { method: 'DELETE' })
        .then(function () {
          toast('已删除批次「' + (b.name || b.batchId) + '」');
          loadHistory();
        })
        .catch(function (err) {
          alert('删除失败：' + err.message);
          delBtn.disabled = false;
        });
    });
    btnRow.appendChild(openBtn);
    btnRow.appendChild(delBtn);

    info.appendChild(nameRow);
    info.appendChild(meta);
    info.appendChild(btnRow);
    card.appendChild(info);
    return card;
  }

  function openBatch(batchId) {
    api('/api/batches/' + encodeURIComponent(batchId)).then(function (batch) {
      state.batchId = batch.batchId;
      renderOriginals(batch.originals);
      showBatchBar(batch);
      els.btnGenerate.disabled = batch.originals.length === 0;
      els.failedList.innerHTML = '';
      setStatus(els.uploadStatus, '已打开归档批次（' + (batch.name || batch.batchId) + '），可继续生成、下载或删除图片');
      loadResults();
      showView('work');
    }).catch(function (e) {
      alert('打开批次失败：' + e.message);
    });
  }

  function showBatchBar(batch) {
    els.batchBar.classList.remove('hidden');
    els.batchNameInput.value = batch.name || batch.batchId;
    setStatus(els.batchNameStatus, '');
  }

  els.btnSaveBatchName.addEventListener('click', function () {
    if (!state.batchId) return;
    var name = els.batchNameInput.value.trim();
    if (!name) { setStatus(els.batchNameStatus, '名称不能为空', true); return; }
    els.btnSaveBatchName.disabled = true;
    api('/api/batches/' + encodeURIComponent(state.batchId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    }).then(function () {
      setStatus(els.batchNameStatus, '已保存 ✓');
    }).catch(function (e) {
      setStatus(els.batchNameStatus, '保存失败：' + e.message, true);
    }).finally(function () {
      els.btnSaveBatchName.disabled = false;
    });
  });

  // ------------------------------------------------------------------ 模板
  function loadTemplate() {
    api('/api/template').then(function (info) {
      els.templatePreview.src = info.url;
      setStatus(els.templateStatus, info.isDefault ? '当前为内置默认模板' : '当前为已上传模板');
    }).catch(function (e) {
      setStatus(els.templateStatus, '模板加载失败：' + e.message, true);
    });
  }

  els.templatePreview.addEventListener('click', function () {
    if (els.templatePreview.src) openLightbox(els.templatePreview.src);
  });

  els.btnPickTemplate.addEventListener('click', function () { els.inputTemplate.click(); });

  els.inputTemplate.addEventListener('change', function () {
    var file = els.inputTemplate.files[0];
    els.inputTemplate.value = '';
    if (!file) return;
    uploadTemplate(file);
  });

  function uploadTemplate(file) {
    var fd = new FormData();
    fd.append('file', file);
    setStatus(els.templateStatus, '上传中...');
    api('/api/template', { method: 'POST', body: fd }).then(function (info) {
      els.templatePreview.src = info.url;
      setStatus(els.templateStatus, '模板已更新 ✓');
    }).catch(function (e) {
      setStatus(els.templateStatus, '模板上传失败：' + e.message, true);
    });
  }

  // ------------------------------------------------------------------ 上传原图
  els.btnPickOriginals.addEventListener('click', function () { els.inputOriginals.click(); });

  els.inputOriginals.addEventListener('change', function () {
    var files = Array.prototype.slice.call(els.inputOriginals.files);
    els.inputOriginals.value = '';
    setPendingFiles(files);
  });

  function setPendingFiles(files) {
    state.pendingFiles = files.filter(function (f) {
      return /\.zip$/i.test(f.name) || (f.type && f.type.indexOf('image/') === 0) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name);
    });
    var zips = state.pendingFiles.filter(function (f) { return /\.zip$/i.test(f.name); });
    var imgs = state.pendingFiles.length - zips.length;
    if (state.pendingFiles.length === 0) {
      setStatus(els.uploadStatus, '未检测到可用文件（仅支持图片和 zip）', true);
    } else {
      setStatus(
        els.uploadStatus,
        '已选择 ' + state.pendingFiles.length + ' 个文件（图片 ' + imgs + '，zip ' + zips.length + '），点击「开始上传」',
      );
    }
    els.btnUpload.disabled = state.pendingFiles.length === 0;
  }

  els.btnUpload.addEventListener('click', function () {
    if (state.pendingFiles.length === 0) return;
    var fd = new FormData();
    state.pendingFiles.forEach(function (f) { fd.append('files', f); });
    els.btnUpload.disabled = true;
    setStatus(els.uploadStatus, '上传中...');
    api('/api/originals', { method: 'POST', body: fd }).then(function (batch) {
      state.batchId = batch.batchId;
      state.pendingFiles = [];
      els.inputOriginals.value = '';
      renderOriginals(batch.originals);
      showBatchBar(batch);
      setStatus(els.uploadStatus, '上传成功 ' + batch.originals.length + ' 张原图（批次 ' + batch.batchId + '）');
      els.btnGenerate.disabled = false;
      loadResults();
    }).catch(function (e) {
      setStatus(els.uploadStatus, '上传失败：' + e.message, true);
      els.btnUpload.disabled = false;
    });
  });

  function renderOriginals(originals) {
    els.originalsList.innerHTML = '';
    originals.forEach(function (o) {
      var box = document.createElement('div');
      box.className = 'thumb-item';
      var img = document.createElement('img');
      img.src = o.url;
      img.alt = o.name;
      img.loading = 'lazy';
      img.addEventListener('click', function () { openLightbox(o.url); });
      var del = document.createElement('button');
      del.className = 'thumb-del';
      del.textContent = '✕';
      del.title = '删除这张原图（连同其生成的喜报）';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        var genCount = o.generated ? o.generated.length : 0;
        if (!confirm('删除原图「' + o.name + '」？' +
          (genCount > 0 ? '\n其已生成的 ' + genCount + ' 张喜报将一并删除，不可恢复。' : ''))) return;
        del.disabled = true;
        api('/api/batches/' + encodeURIComponent(state.batchId) + '/originals', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: o.name }),
        }).then(function () {
          return api('/api/batches/' + encodeURIComponent(state.batchId));
        }).then(function (batch) {
          renderOriginals(batch.originals);
          if (batch.originals.length === 0) {
            els.btnGenerate.disabled = true;
            setStatus(els.uploadStatus, '该批次原图已全部删除');
          }
          loadResults();
          toast('已删除 ' + o.name + (genCount > 0 ? '（连同 ' + genCount + ' 张喜报）' : ''));
        }).catch(function (err) {
          alert('删除失败：' + err.message);
          del.disabled = false;
        });
      });
      var name = document.createElement('div');
      name.className = 'thumb-name';
      name.textContent = o.name;
      box.appendChild(del);
      box.appendChild(img);
      box.appendChild(name);
      els.originalsList.appendChild(box);
    });
  }

  // ------------------------------------------------------------------ 生成 & 轮询
  function startPolling(jobId, onDone) {
    stopPolling();
    els.progressBox.classList.remove('hidden');
    state.polling = setInterval(function () {
      api('/api/jobs/' + jobId).then(function (job) {
        els.progressFill.style.width = job.progress + '%';
        els.progressText.textContent =
          '生成中 ' + job.done + '/' + job.total + '（成功 ' + job.ok + '，失败 ' + job.failed + '）' + job.progress + '%';
        // 增量上图: 每生成好一张立刻出现在结果区, 不必等任务整体完成
        renderIncremental(job);
        if (job.status === 'done') {
          stopPolling();
          els.progressText.textContent =
            '完成：' + job.done + '/' + job.total + '（成功 ' + job.ok + '，失败 ' + job.failed + '）';
          renderFailed(job);
          if (onDone) onDone(job);
        }
      }).catch(function (e) {
        stopPolling();
        els.progressText.textContent = '进度查询失败：' + e.message;
      });
    }, 2000);
  }

  function stopPolling() {
    if (state.polling) { clearInterval(state.polling); state.polling = null; }
  }

  function renderFailed(job) {
    els.failedList.innerHTML = '';
    var failed = job.items.filter(function (it) { return it.status === 'error'; });
    // 按原图聚合失败项
    var byOriginal = {};
    failed.forEach(function (it) {
      byOriginal[it.original] = byOriginal[it.original] || { count: 0, errors: [] };
      byOriginal[it.original].count += 1;
      if (byOriginal[it.original].errors.indexOf(it.error) === -1) {
        byOriginal[it.original].errors.push(it.error);
      }
    });
    Object.keys(byOriginal).forEach(function (name) {
      var info = byOriginal[name];
      var row = document.createElement('div');
      row.className = 'failed-item';
      var reason = document.createElement('div');
      reason.className = 'reason';
      reason.textContent = name + '：失败 ' + info.count + ' 张（' + info.errors[0] + '）';
      var btn = document.createElement('button');
      btn.className = 'btn btn-mini';
      btn.textContent = '重试';
      btn.addEventListener('click', function () {
        row.remove();
        generateMore(name, info.count);
      });
      row.appendChild(reason);
      row.appendChild(btn);
      els.failedList.appendChild(row);
    });
  }

  els.btnGenerate.addEventListener('click', function () {
    if (!state.batchId) return;
    var count = Math.max(1, Math.min(10, parseInt(els.inputCount.value, 10) || 4));
    els.btnGenerate.disabled = true;
    els.failedList.innerHTML = '';
    els.progressFill.style.width = '0%';
    setStatus(els.progressText, '任务创建中...');
    // 先确保结果区分组骨架已渲染, 轮询期间才能增量追加(已渲染则无副作用)
    loadResults();
    api('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: state.batchId, count: count, prompt: currentPrompt() }),
    }).then(function (r) {
      startPolling(r.jobId, function () {
        els.btnGenerate.disabled = false;
        loadResults();
      });
    }).catch(function (e) {
      setStatus(els.progressText, '创建任务失败：' + e.message, true);
      els.btnGenerate.disabled = false;
    });
  });

  function generateMore(original, count) {
    if (!state.batchId) return;
    api('/api/batches/' + encodeURIComponent(state.batchId) + '/more', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ original: original, count: count, prompt: currentPrompt() }),
    }).then(function (r) {
      startPolling(r.jobId, function () { loadResults(); });
    }).catch(function (e) {
      alert('追加生成失败：' + e.message);
    });
  }

  // ------------------------------------------------------------------ 结果区
  function loadResults() {
    if (!state.batchId) return;
    api('/api/batches/' + encodeURIComponent(state.batchId)).then(function (batch) {
      renderResults(batch);
    }).catch(function () { /* 轮询时静默 */ });
  }

  /**
   * 全量渲染结果区: 每张原图一个 .result-group(含 header + 常驻 .gen-grid)。
   * 无生成图时额外放"暂无生成结果"占位(引用存 groupEls, 供增量上图时移除)。
   * 骨架/计数同步登记到 state.groupEls 与 state.renderedFiles, 供轮询增量使用。
   */
  function renderResults(batch) {
    els.resultGroups.innerHTML = '';
    state.groupEls = {};
    state.renderedFiles = new Set();
    state.slotEls = {}; // 全量重绘后旧占位全部失效, 防串批次
    batch.originals.forEach(function (o) {
      var group = document.createElement('div');
      group.className = 'result-group';

      var header = document.createElement('div');
      header.className = 'result-group-header';
      var thumb = document.createElement('img');
      thumb.src = o.url;
      thumb.alt = o.name;
      thumb.addEventListener('click', function () { openLightbox(o.url); });
      var nameEl = document.createElement('div');
      nameEl.className = 'orig-name';

      var moreRow = document.createElement('div');
      moreRow.className = 'more-row';
      var moreInput = document.createElement('input');
      moreInput.type = 'number';
      moreInput.min = '1';
      moreInput.max = '10';
      moreInput.value = '1';
      var moreBtn = document.createElement('button');
      moreBtn.className = 'btn btn-mini';
      moreBtn.textContent = '再生成';
      moreBtn.addEventListener('click', function () {
        var n = Math.max(1, Math.min(10, parseInt(moreInput.value, 10) || 1));
        generateMore(o.name, n);
      });
      moreRow.appendChild(moreInput);
      moreRow.appendChild(moreBtn);

      header.appendChild(thumb);
      header.appendChild(nameEl);
      header.appendChild(moreRow);
      group.appendChild(header);

      // 始终创建 gen-grid; 无生成图时放占位(增量上图时移除)
      var grid = document.createElement('div');
      grid.className = 'gen-grid';
      var emptyEl = null;
      if (o.generated.length === 0) {
        emptyEl = document.createElement('div');
        emptyEl.className = 'empty-result';
        emptyEl.textContent = '暂无生成结果';
        group.appendChild(emptyEl);
      }
      var ge = {
        grid: grid,
        nameEl: nameEl,
        emptyEl: emptyEl,
        baseName: o.name,
        count: 0,
      };
      state.groupEls[o.folder] = ge;

      o.generated.forEach(function (g) {
        state.renderedFiles.add(g.file);
        ge.count += 1;
        grid.appendChild(buildGenItem(batch.batchId, g));
      });
      group.appendChild(grid);
      els.resultGroups.appendChild(group);
      updateGroupCount(o.folder);
    });
    updateSelection();
  }

  /**
   * 增量追加一张刚生成完成的图(轮询期间实时上图)。
   * 若对应分组骨架尚未渲染(如生成先于首轮 renderResults 完成的竞态), 本轮跳过, 后续轮询会补屏。
   * insertKey 为任务项的 key: 传入时按 key 升序插入到对应占位之间的正确位置(保序渲染)。
   * @param {{file: string, url: string}} g
   * @param {number} [insertKey]
   */
  function appendGenerated(g, insertKey) {
    if (!g || !g.file || state.renderedFiles.has(g.file)) return;
    var folder = g.file.split('/')[0];
    var ge = state.groupEls[folder];
    if (!ge) return;
    if (ge.emptyEl) {
      ge.emptyEl.remove();
      ge.emptyEl = null;
    }
    var item = buildGenItem(state.batchId, g);
    item.classList.add('new'); // 触发淡入动画, 提示"刚生成"
    insertOrdered(ge.grid, item, insertKey);
    state.renderedFiles.add(g.file);
    ge.count += 1;
    updateGroupCount(folder);
    updateSelection();
  }

  /** 按 key 升序把元素插入网格(保持任务项顺序), key 缺省时直接追加到末尾。 */
  function insertOrdered(grid, el, key) {
    if (typeof key !== 'number') {
      grid.appendChild(el);
      return;
    }
    el.dataset.slotKey = String(key);
    var kids = grid.children;
    for (var i = 0; i < kids.length; i += 1) {
      var k = kids[i].dataset ? kids[i].dataset.slotKey : undefined;
      if (k !== undefined && Number(k) > key) {
        grid.insertBefore(el, kids[i]);
        return;
      }
    }
    grid.appendChild(el);
  }

  /** 任务项对应的结果分组 folder: 优先用后端透出的 folder, 缺省时由原图名推导。 */
  function itemFolder(it) {
    if (it.folder) return it.folder;
    var base = String(it.original || 'img').replace(/\.[^.]+$/, '');
    return base || 'img';
  }

  /** 构建"生成中"占位卡片: 转圈动画 + 文案, 点击提示仍在生成。 */
  function buildLoadingSlot(it) {
    var slot = document.createElement('div');
    slot.className = 'gen-item loading';
    slot.dataset.slotKey = String(it.key);
    var spinner = document.createElement('div');
    spinner.className = 'spinner';
    var text = document.createElement('div');
    text.className = 'loading-text';
    text.textContent = '生成中';
    slot.appendChild(spinner);
    slot.appendChild(text);
    slot.addEventListener('click', function () {
      toast('该图仍在生成中，请稍候…');
    });
    return slot;
  }

  /** 构建"生成失败"卡片: 红色虚线框, 点击 toast 失败原因。 */
  function buildErrorItem(error, key) {
    var item = document.createElement('div');
    item.className = 'gen-item error';
    if (typeof key === 'number') item.dataset.slotKey = String(key);
    var text = document.createElement('div');
    text.className = 'error-text';
    text.textContent = '生成失败';
    item.appendChild(text);
    item.addEventListener('click', function () {
      toast('生成失败：' + (error || '未知错误'));
    });
    return item;
  }

  /**
   * 第一步: 为任务中尚未上图的 pending/running 项在各自分组的网格里建占位卡片(按 key 顺序),
   * 保证 1、3 先好、2 未好时 2 的位置仍保留。已 ok/error 的项交给 fill 阶段处理。
   * 分组骨架尚未渲染(竞态)时跳过, 下轮轮询补建。
   */
  function ensureSlots(job) {
    job.items.forEach(function (it) {
      if (it.status === 'ok' || it.status === 'error') return;
      var slotKey = job.id + '#' + it.key;
      if (state.slotEls[slotKey]) return; // 已建占位
      var ge = state.groupEls[itemFolder(it)];
      if (!ge) return;
      if (ge.emptyEl) {
        ge.emptyEl.remove();
        ge.emptyEl = null;
      }
      var slot = buildLoadingSlot(it);
      insertOrdered(ge.grid, slot, it.key);
      state.slotEls[slotKey] = slot;
    });
  }

  /**
   * 增量渲染(轮询每轮调用): 先补占位, 再把已完成的项原地替换占位(保序),
   * 失败项转为错误卡片。完成后由 loadResults() 全量重绘收尾。
   */
  function renderIncremental(job) {
    if (!job || !job.items) return;
    ensureSlots(job);
    job.items.forEach(function (it) {
      var slotKey = job.id + '#' + it.key;
      var folder = itemFolder(it);
      if (it.status === 'ok' && it.file) {
        var g = {
          file: it.file,
          url: '/generated/' + encodeURIComponent(job.batchId) + '/' +
            it.file.split('/').map(encodeURIComponent).join('/'),
        };
        var slot = state.slotEls[slotKey];
        if (slot && slot.parentNode) {
          // 原地替换占位, 位置保持任务项顺序
          var real = buildGenItem(job.batchId, g);
          real.classList.add('new'); // 触发淡入动画, 提示"刚生成"
          real.dataset.slotKey = String(it.key);
          slot.replaceWith(real);
          delete state.slotEls[slotKey];
          if (!state.renderedFiles.has(g.file)) {
            state.renderedFiles.add(g.file);
            var ge = state.groupEls[folder];
            if (ge) {
              ge.count += 1;
              updateGroupCount(folder);
            }
            updateSelection();
          }
        } else {
          // 无占位(如全量重绘后又完成), 退化追加并按 key 保序插入
          appendGenerated(g, it.key);
        }
      } else if (it.status === 'error') {
        var errSlot = state.slotEls[slotKey];
        var errItem = buildErrorItem(it.error, it.key);
        if (errSlot && errSlot.parentNode) {
          errSlot.replaceWith(errItem);
          delete state.slotEls[slotKey];
        } else {
          var ge2 = state.groupEls[folder];
          if (ge2) insertOrdered(ge2.grid, errItem, it.key);
        }
      }
    });
  }

  // ------------------------------------------------------------------ 逐张下载(手机端友好)
  function isIOS() {
    return /iP(hone|ad|od)/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  /** 轻提示条, 2.6 秒后自动消失。 */
  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 300);
    }, 2600);
  }

  /** 下载文件名: 批次名-folder-文件名, 非法字符替换。 */
  function makeDownloadName(file) {
    var prefix = (els.batchNameInput && els.batchNameInput.value.trim()) || state.batchId || 'xibao';
    var safe = prefix.replace(/[\\/:*?"<>|]/g, '_');
    return safe + '-' + file.replace(/\//g, '-');
  }

  /** 单张下载: iOS 直接打开图片引导长按保存(系统限制无法静默存相册); 其他端 blob 触发下载。 */
  function downloadOne(url, file) {
    if (isIOS()) {
      window.open(url, '_blank');
      toast('iPhone/iPad 请长按图片 → 存储到"照片"');
      return;
    }
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      var u = URL.createObjectURL(blob);
      a.href = u;
      a.download = makeDownloadName(file);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 5000);
    }).catch(function (e) {
      toast('下载失败：' + e.message);
    });
  }

  /** 勾选图的 file -> URL(与后端 listBatch 规则一致)。 */
  function fileToUrl(file) {
    return '/generated/' + encodeURIComponent(state.batchId) + '/' +
      file.split('/').map(encodeURIComponent).join('/');
  }

  /**
   * 构建单个生成图卡片(.gen-item): 左上角删除按钮、点击预览、右下角勾选框。
   * 删除成功后整页 loadResults() 重新对齐磁盘状态。
   * @param {string} batchId 当前批次 ID
   * @param {{file: string, url: string}} g 生成图信息(file 形如 "folder/1.jpg")
   * @returns {HTMLElement}
   */
  function buildGenItem(batchId, g) {
    var item = document.createElement('div');
    item.className = 'gen-item';

    var img = document.createElement('img');
    img.src = g.url;
    img.alt = g.file;
    img.loading = 'lazy';
    img.addEventListener('click', function () { openLightbox(g.url); });

    var delBtn = document.createElement('button');
    delBtn.className = 'del-btn';
    delBtn.textContent = '✕';
    delBtn.title = '删除这张图';
    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!confirm('确定删除这张已生成图片吗？删除后不可恢复。')) return;
      delBtn.disabled = true;
      api('/api/batches/' + encodeURIComponent(batchId) + '/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: g.file }),
      }).then(function () {
        loadResults();
      }).catch(function (err) {
        alert('删除失败：' + err.message);
        delBtn.disabled = false;
      });
    });

    var dlBtn = document.createElement('button');
    dlBtn.className = 'dl-btn';
    dlBtn.textContent = '⬇';
    dlBtn.title = '下载这张图';
    dlBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      downloadOne(g.url, g.file);
    });

    var wrap = document.createElement('div');
    wrap.className = 'check-wrap';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.file = g.file;
    cb.addEventListener('change', function () {
      item.classList.toggle('selected', cb.checked);
      updateSelection();
    });
    wrap.appendChild(cb);

    item.appendChild(delBtn);
    item.appendChild(dlBtn);
    item.appendChild(img);
    item.appendChild(wrap);
    return item;
  }

  /** 更新某一分组标题中的"已生成 X 张"计数。 */
  function updateGroupCount(folder) {
    var ge = state.groupEls[folder];
    if (!ge) return;
    ge.nameEl.textContent = ge.baseName + '（已生成 ' + ge.count + ' 张）';
  }

  function allCheckboxes() {
    return Array.prototype.slice.call(els.resultGroups.querySelectorAll('input[type="checkbox"]'));
  }

  function updateSelection() {
    var cbs = allCheckboxes();
    var checked = cbs.filter(function (c) { return c.checked; });
    els.selectedCount.textContent = '已选 ' + checked.length + ' 张';
    els.btnDownload.disabled = checked.length === 0;
    els.btnDownloadEach.disabled = checked.length === 0;
  }

  els.btnSelectAll.addEventListener('click', function () {
    allCheckboxes().forEach(function (c) {
      c.checked = true;
      c.closest('.gen-item').classList.add('selected');
    });
    updateSelection();
  });

  els.btnInvert.addEventListener('click', function () {
    allCheckboxes().forEach(function (c) {
      c.checked = !c.checked;
      c.closest('.gen-item').classList.toggle('selected', c.checked);
    });
    updateSelection();
  });

  els.btnDownloadEach.addEventListener('click', function () {
    var files = allCheckboxes()
      .filter(function (c) { return c.checked; })
      .map(function (c) { return c.dataset.file; });
    if (files.length === 0) return;
    if (isIOS()) {
      toast('iPhone/iPad 请点每张图上的 ⬇ 按钮，打开后长按保存到相册');
      return;
    }
    els.btnDownloadEach.disabled = true;
    var i = 0;
    toast('开始逐张下载，共 ' + files.length + ' 张');
    var timer = setInterval(function () {
      if (i >= files.length) {
        clearInterval(timer);
        els.btnDownloadEach.disabled = false;
        updateSelection();
        toast('已全部触发下载 ✓');
        return;
      }
      downloadOne(fileToUrl(files[i]), files[i]);
      i += 1;
    }, 400);
  });

  els.btnDownload.addEventListener('click', function () {
    var files = allCheckboxes()
      .filter(function (c) { return c.checked; })
      .map(function (c) { return c.dataset.file; });
    if (files.length === 0) return;
    fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: state.batchId, files: files }),
    }).then(function (resp) {
      if (!resp.ok) throw new Error('下载失败 HTTP ' + resp.status);
      return resp.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      var url = URL.createObjectURL(blob);
      a.href = url;
      a.download = 'xibao-' + state.batchId + '.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }).catch(function (e) {
      alert(e.message);
    });
  });

  // ------------------------------------------------------------------ 拖拽上传
  // 阻止浏览器默认行为（避免拖进来的文件被直接打开）
  ['dragover', 'drop'].forEach(function (evt) {
    document.addEventListener(evt, function (e) { e.preventDefault(); });
  });

  function setupDropZone(zone, onFiles) {
    if (!zone) return;
    var depth = 0;
    zone.addEventListener('dragenter', function (e) {
      e.preventDefault();
      depth += 1;
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('dragleave', function (e) {
      e.preventDefault();
      depth -= 1;
      if (depth <= 0) { depth = 0; zone.classList.remove('dragover'); }
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      zone.classList.remove('dragover');
      var files = Array.prototype.slice.call(e.dataTransfer.files || []);
      if (files.length > 0) onFiles(files);
    });
  }

  setupDropZone(els.templateDrop, function (files) {
    var img = files.filter(function (f) {
      return (f.type && f.type.indexOf('image/') === 0) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name);
    })[0];
    if (!img) {
      setStatus(els.templateStatus, '拖入的文件中没有图片，模板仅支持图片文件', true);
      return;
    }
    uploadTemplate(img);
  });

  setupDropZone(els.originalsDrop, function (files) {
    setPendingFiles(files);
  });

  // ------------------------------------------------------------------ 预览与初始化
  els.lightboxClose.addEventListener('click', function () {
    els.lightbox.classList.add('hidden');
  });
  els.lightbox.addEventListener('click', function (e) {
    if (e.target === els.lightbox) els.lightbox.classList.add('hidden');
  });

  api('/api/config').then(function (cfg) {
    state.defaultPrompt = cfg.defaultPrompt || '';
    els.promptInput.value = state.defaultPrompt;
  }).catch(function () { /* 提示词预填失败可忽略 */ });

  loadTemplate();
})();
