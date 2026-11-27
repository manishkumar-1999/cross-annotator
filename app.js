/* Page behaviour for the Cross Annotator website. Conversion logic lives in core.js. */
(function () {
  "use strict";

  var CA = window.CrossAnnotator;
  var LIST_LIMIT = 500; // rows shown per list on the page; the summary file has all of them

  var el = function (id) { return document.getElementById(id); };
  var form = el("form");
  var fileInput = el("file");
  var dropzone = el("dropzone");
  var sourceSelect = el("source_db");
  var targetSelect = el("target_db");
  var outputInput = el("output");
  var convertButton = el("convert");
  var statusText = el("status");
  var errorBox = el("error");
  var results = el("results");

  var state = { fileName: null, fileText: null, matrix: null, csv: null, summary: null, outName: null };
  var mappingCache = {};

  // ---------- database selects ----------

  function seqType() {
    return form.querySelector('input[name="seq_type"]:checked').value;
  }

  function option(db) {
    var o = document.createElement("option");
    o.value = db;
    o.textContent = CA.DATABASE_LABELS[db] === db ? db : CA.DATABASE_LABELS[db] + " (" + db + ")";
    return o;
  }

  function fillSources() {
    var dbs = CA.DATABASES[seqType()];
    var keep = sourceSelect.value;
    sourceSelect.innerHTML = "";
    dbs.forEach(function (db) { sourceSelect.appendChild(option(db)); });
    if (dbs.indexOf(keep) >= 0) sourceSelect.value = keep;
    fillTargets();
  }

  function fillTargets() {
    var keep = targetSelect.value;
    var dbs = CA.DATABASES[seqType()].filter(function (db) { return db !== sourceSelect.value; });
    targetSelect.innerHTML = "";
    dbs.forEach(function (db) { targetSelect.appendChild(option(db)); });
    if (dbs.indexOf(keep) >= 0) targetSelect.value = keep;
    el("mapping-help").textContent = "Mapping file: " +
      CA.mappingFile(seqType(), sourceSelect.value, targetSelect.value).split("/").pop();
    resetResults();
  }

  // ---------- file input ----------

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }
  function resetResults() {
    results.hidden = true;
    state.csv = state.summary = null;
    updateButton();
  }
  function updateButton() {
    convertButton.disabled = !state.matrix;
  }

  function loadFile(file) {
    clearError();
    resetResults();
    state.matrix = null;
    state.fileName = file.name;
    el("dz-main").textContent = file.name;
    el("dz-sub").textContent = "Reading…";
    var reader = new FileReader();
    reader.onload = function () {
      try {
        state.fileText = reader.result;
        state.matrix = CA.readMatrix(reader.result);
        el("dz-sub").textContent = state.matrix.sampleIds.length + " samples × " +
          state.matrix.species.length + " species · click to choose another file";
        dropzone.classList.add("loaded");
        outputInput.placeholder = CA.defaultOutputName(file.name);
      } catch (err) {
        state.matrix = null;
        dropzone.classList.remove("loaded");
        el("dz-sub").textContent = "This file can't be used. See the message below.";
        showError(err.message || String(err));
      }
      updateButton();
    };
    reader.onerror = function () {
      showError("The file could not be read.");
      el("dz-sub").textContent = "";
    };
    reader.readAsText(file);
  }

  fileInput.addEventListener("change", function () {
    if (fileInput.files.length) loadFile(fileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach(function (type) {
    dropzone.addEventListener(type, function (e) {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (type) {
    dropzone.addEventListener(type, function (e) {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });
  dropzone.addEventListener("drop", function (e) {
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  });

  // ---------- mapping data (data/*.js, loaded on demand) ----------

  function loadMappingText(rel) {
    if (mappingCache[rel]) return Promise.resolve(mappingCache[rel]);
    var store = window.CROSS_ANNOTATOR_DATA || {};
    if (store[rel]) return Promise.resolve((mappingCache[rel] = store[rel]));
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      var parts = rel.split("/");
      script.src = "data/" + parts[0] + "_" + parts[1].replace(/\.(csv|tsv)$/, "") + ".js";
      script.onload = function () {
        var text = (window.CROSS_ANNOTATOR_DATA || {})[rel];
        if (text) resolve((mappingCache[rel] = text));
        else reject(new Error("Mapping file " + rel + " did not load."));
      };
      script.onerror = function () {
        reject(new Error("Could not load the mapping file " + parts[1] + ". Is the data folder next to index.html?"));
      };
      document.head.appendChild(script);
    });
  }

  // ---------- conversion ----------

  function timestamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
      p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function outputName() {
    var name = outputInput.value.trim();
    if (!name) return CA.defaultOutputName(state.fileName);
    return /\.[A-Za-z0-9]+$/.test(name) ? name : name + ".csv";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!state.matrix) return;
    clearError();
    var seq = seqType();
    var src = sourceSelect.value;
    var tgt = targetSelect.value;
    var rel;
    try {
      rel = CA.mappingFile(seq, src, tgt);
    } catch (err) {
      showError(err.message);
      return;
    }
    convertButton.disabled = true;
    statusText.textContent = "Converting…";

    loadMappingText(rel).then(function (text) {
      var mapping = CA.loadMapping(seq, src, tgt, text);
      var res = CA.convert(state.matrix, mapping);
      state.outName = outputName();
      state.csv = CA.writeMatrix(res.matrix);
      state.summary = CA.formatSummary(res.report, state.fileName, state.outName, timestamp());
      showResults(res.report);
      statusText.textContent = "Done.";
    }).catch(function (err) {
      showError(err.message || String(err));
      statusText.textContent = "";
    }).then(updateButton);
  });

  // ---------- results ----------

  function stat(value, name, highlight) {
    var div = document.createElement("div");
    div.className = "stat" + (highlight ? " highlight" : "");
    var v = document.createElement("div");
    v.className = "value";
    v.textContent = value;
    var n = document.createElement("div");
    n.className = "name";
    n.textContent = name;
    div.appendChild(v);
    div.appendChild(n);
    return div;
  }

  function fillList(id, countId, lines) {
    var box = el(id);
    box.innerHTML = "";
    el(countId).textContent = "(" + lines.length + ")";
    if (!lines.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "None.";
      box.appendChild(empty);
      return;
    }
    lines.slice(0, LIST_LIMIT).forEach(function (line) {
      var row = document.createElement("div");
      row.textContent = line;
      box.appendChild(row);
    });
    if (lines.length > LIST_LIMIT) {
      var more = document.createElement("div");
      more.className = "empty";
      more.textContent = "… and " + (lines.length - LIST_LIMIT) + " more (all are in the summary file).";
      box.appendChild(more);
    }
  }

  function showResults(report) {
    var m = report.mapping;
    var n = report.columns.length;
    var converted = CA.count(report, CA.CONVERTED);
    var pct = n ? ((100 * converted) / n).toFixed(2) + "%" : "n/a";

    el("result-meta").textContent = m.sourceDb + " → " + m.targetDb + " (" + m.seqType + ") using " +
      m.fileName + " · " + report.nSamples + " samples · output: " + state.outName;

    var stats = el("stats");
    stats.innerHTML = "";
    stats.appendChild(stat(n, "Input species"));
    stats.appendChild(stat(converted, "Converted (" + pct + ")", true));
    stats.appendChild(stat(CA.count(report, CA.CASE_ONLY), "Case only"));
    stats.appendChild(stat(CA.count(report, CA.UNCHANGED), "Unchanged"));
    stats.appendChild(stat(CA.count(report, CA.NOT_FOUND), "Not found"));
    stats.appendChild(stat(CA.nMergedColumns(report) + " → " + report.merged.size, "Columns merged"));
    stats.appendChild(stat(report.nOutputColumns, "Output species", true));

    el("case-note").hidden = !CA.count(report, CA.CASE_ONLY);
    el("wgs-note").hidden = m.seqType !== "WGS";

    var merged = [];
    report.merged.forEach(function (originals, name) { merged.push(name + " = " + originals.join(" + ")); });
    fillList("merged-list", "merged-count", merged);
    fillList("converted-list", "converted-count", report.columns
      .filter(function (c) { return c.status === CA.CONVERTED; })
      .map(function (c) { return c.original + " → " + c.newName; }));
    fillList("notfound-list", "notfound-count", report.columns
      .filter(function (c) { return c.status === CA.NOT_FOUND; })
      .map(function (c) { return c.original; }));
    el("summary-text").textContent = state.summary;

    results.hidden = false;
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function download(text, name, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  el("dl-csv").addEventListener("click", function () {
    if (state.csv) download(state.csv, state.outName, "text/csv");
  });
  el("dl-summary").addEventListener("click", function () {
    if (state.summary) download(state.summary, CA.summaryNameFor(state.outName), "text/plain");
  });

  // ---------- wiring ----------

  form.querySelectorAll('input[name="seq_type"]').forEach(function (radio) {
    radio.addEventListener("change", fillSources);
  });
  sourceSelect.addEventListener("change", fillTargets);
  targetSelect.addEventListener("change", function () {
    el("mapping-help").textContent = "Mapping file: " +
      CA.mappingFile(seqType(), sourceSelect.value, targetSelect.value).split("/").pop();
    resetResults();
  });
  outputInput.addEventListener("input", function () {
    if (state.csv) resetResults();
  });

  fillSources();
})();
