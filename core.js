/*
 * Cross Annotator conversion logic for the browser.
 * Mirrors src/cross_annotator/registry.py and core.py; keep the two in step.
 * Works in the browser (window.CrossAnnotator) and in Node (module.exports) for testing.
 */
(function (root) {
  "use strict";

  // ---------- registry (registry.py) ----------

  var SEQ_TYPES = ["16S", "WGS"];

  var DATABASES = {
    "16S": ["SILVA", "RDP_11.2", "RDP_18"],
    "WGS": ["k2", "m3", "m4"],
  };

  var DATABASE_LABELS = {
    "SILVA": "SILVA",
    "RDP_11.2": "RDP 11.2",
    "RDP_18": "RDP 18",
    "k2": "Kraken2",
    "m3": "MetaPhlAn 3",
    "m4": "MetaPhlAn 4",
  };

  var MAPPING_FILES = {
    "16S|RDP_11.2|SILVA": "16S/rdp11.2tosilva.csv",
    "16S|SILVA|RDP_11.2": "16S/silvatordp11.2.csv",
    "16S|RDP_11.2|RDP_18": "16S/rdp11.2tordp18.csv",
    "16S|RDP_18|RDP_11.2": "16S/rdp18tordp11.2.csv",
    "16S|RDP_18|SILVA": "16S/rdp18tosilva.csv",
    "16S|SILVA|RDP_18": "16S/silvatordp18.csv",
    "WGS|k2|m3": "WGS/k2_to_m3_ncbi_crossmap_d.tsv",
    "WGS|m3|k2": "WGS/m3_to_k2_ncbi_crossmap_d.tsv",
    "WGS|k2|m4": "WGS/k2_to_m4_ncbi_crossmap_d.tsv",
    "WGS|m4|k2": "WGS/m4_to_k2_ncbi_crossmap_d.tsv",
    "WGS|m3|m4": "WGS/m3_to_m4_ncbi_crossmap_s.tsv",
    "WGS|m4|m3": "WGS/m4_to_m3_ncbi_crossmap_s.tsv",
  };

  function mappingFile(seqType, sourceDb, targetDb) {
    if (sourceDb === targetDb) {
      throw new InputError("source and target database are the same (" + sourceDb + "); nothing to convert");
    }
    var rel = MAPPING_FILES[seqType + "|" + sourceDb + "|" + targetDb];
    if (!rel) throw new InputError("no mapping file for " + sourceDb + " -> " + targetDb + " (" + seqType + ")");
    return rel;
  }

  // ---------- statuses (core.py) ----------

  var CONVERTED = "converted"; // found in the mapping file, given a new name
  var CASE_ONLY = "case_only"; // target differs only in upper/lower case; user's spelling kept
  var UNCHANGED = "unchanged"; // found in the mapping file, name is the same in the target
  var NOT_FOUND = "not_found"; // not in the mapping file, original name kept

  function InputError(message) {
    this.name = "InputError";
    this.message = message;
  }
  InputError.prototype = Object.create(Error.prototype);

  // ---------- CSV reading (Python csv module, default dialect) ----------

  function parseDelimited(text, delimiter) {
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var fieldStarted = false;
    var i = 0;
    var n = text.length;
    while (i < n) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
        } else {
          field += c;
        }
        i += 1;
        continue;
      }
      if (c === '"' && !fieldStarted) {
        inQuotes = true;
        fieldStarted = true;
      } else if (c === delimiter) {
        row.push(field);
        field = "";
        fieldStarted = false;
      } else if (c === "\r" || c === "\n") {
        if (fieldStarted || row.length) row.push(field);
        if (row.length) rows.push(row);
        row = [];
        field = "";
        fieldStarted = false;
        if (c === "\r" && text[i + 1] === "\n") i += 1;
      } else {
        field += c;
        fieldStarted = true;
      }
      i += 1;
    }
    if (fieldStarted || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows; // blank lines are skipped, as in core.py
  }

  // ---------- mapping (core.load_mapping) ----------

  function loadMapping(seqType, sourceDb, targetDb, text) {
    var rel = mappingFile(seqType, sourceDb, targetDb);
    var delimiter = /\.tsv$/.test(rel) ? "\t" : ",";
    var rows = parseDelimited(text, delimiter).slice(1);

    var exact = new Map();
    var lowerTargets = new Map();
    rows.forEach(function (row) {
      var source = row[0].trim();
      var target = row[1].trim();
      if (!exact.has(source)) exact.set(source, target);
      var key = source.toLowerCase();
      if (!lowerTargets.has(key)) lowerTargets.set(key, new Set());
      lowerTargets.get(key).add(target);
    });

    // A lower-case key is only usable if it points to one target (ignoring case).
    var ignoreCase = new Map();
    lowerTargets.forEach(function (targets, key) {
      var list = Array.from(targets);
      var lowered = new Set(list.map(function (t) { return t.toLowerCase(); }));
      if (lowered.size === 1) ignoreCase.set(key, list.sort()[0]);
    });

    return {
      seqType: seqType,
      sourceDb: sourceDb,
      targetDb: targetDb,
      fileName: rel.split("/").pop(),
      exact: exact,
      ignoreCase: ignoreCase,
    };
  }

  // ---------- matrix reading (core.read_matrix) ----------

  // pandas' default missing-value strings
  var NA_VALUES = new Set(["", "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan",
    "1.#IND", "1.#QNAN", "<NA>", "N/A", "NA", "NULL", "NaN", "None", "n/a", "nan", "null"]);
  var NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  var INF_RE = /^[+-]?(inf|infinity)$/i;

  function parseValue(raw) {
    if (NA_VALUES.has(raw)) return NaN;
    var s = raw.trim();
    if (NUMBER_RE.test(s)) return Number(s);
    if (INF_RE.test(s)) return s[0] === "-" ? -Infinity : Infinity;
    return undefined; // not numeric
  }

  function readMatrix(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM
    var firstLine = text.split(/\r?\n/, 1)[0];
    if (!firstLine.trim()) throw new InputError("input file is empty");
    var tabs = (firstLine.match(/\t/g) || []).length;
    var commas = (firstLine.match(/,/g) || []).length;
    var delimiter = tabs > commas ? "\t" : ",";

    var rows = parseDelimited(text, delimiter);
    var header = rows[0];
    if (header.length < 2) {
      throw new InputError("input must have a sample-ID column followed by at least one species column");
    }
    var dataRows = rows.slice(1);
    var width = dataRows.length ? dataRows[0].length : header.length;
    dataRows.forEach(function (r, k) {
      if (r.length > width) {
        throw new InputError("row " + (k + 2) + " has " + r.length + " fields, expected " + width);
      }
    });
    if (width !== header.length) {
      throw new InputError("header has " + header.length + " columns but the data rows have " + width);
    }

    var species = header.slice(1).map(function (name) { return name.trim(); });
    var nCols = species.length;
    var sampleIds = [];
    var columns = species.map(function () { return new Float64Array(dataRows.length); });
    var bad = new Set();

    dataRows.forEach(function (r, i) {
      var id = r[0];
      sampleIds.push(NA_VALUES.has(id) ? "" : id);
      for (var j = 0; j < nCols; j++) {
        var raw = j + 1 < r.length ? r[j + 1] : "";
        var v = parseValue(raw);
        if (v === undefined) {
          bad.add(j);
          v = NaN;
        }
        columns[j][i] = v;
      }
    });

    if (bad.size) {
      var names = Array.from(bad).sort(function (a, b) { return a - b; }).map(function (j) { return species[j]; });
      var shown = names.slice(0, 5).join(", ") + (names.length > 5 ? " ..." : "");
      throw new InputError(names.length + " species column(s) contain non-numeric values: " + shown);
    }

    return { indexName: header[0], sampleIds: sampleIds, species: species, columns: columns };
  }

  // ---------- conversion (core.convert) ----------

  function convert(matrix, mapping) {
    var results = matrix.species.map(function (name) {
      var newName;
      var match;
      if (mapping.exact.has(name)) {
        newName = mapping.exact.get(name);
        match = "exact";
      } else if (mapping.ignoreCase.has(name.toLowerCase())) {
        newName = mapping.ignoreCase.get(name.toLowerCase());
        match = "ignore_case";
      } else {
        return { original: name, newName: name, status: NOT_FOUND, match: "" };
      }
      var status;
      if (newName === name) {
        status = UNCHANGED;
      } else if (newName.toLowerCase() === name.toLowerCase()) {
        // Same species, only the case differs: keep the user's spelling.
        newName = name;
        status = CASE_ONLY;
      } else {
        status = CONVERTED;
      }
      return { original: name, newName: newName, status: status, match: match };
    });

    // Group input column positions by their new name, keeping first-seen order.
    var groups = new Map();
    results.forEach(function (r, position) {
      if (!groups.has(r.newName)) groups.set(r.newName, []);
      groups.get(r.newName).push(position);
    });

    var nRows = matrix.sampleIds.length;
    var outNames = [];
    var outColumns = [];
    var merged = new Map();
    groups.forEach(function (positions, newName) {
      outNames.push(newName);
      if (positions.length === 1) {
        outColumns.push(matrix.columns[positions[0]]);
        return;
      }
      // Row-wise sum; a row that is missing in every column stays missing (min_count=1).
      var sum = new Float64Array(nRows);
      for (var i = 0; i < nRows; i++) {
        var total = 0;
        var seen = false;
        for (var k = 0; k < positions.length; k++) {
          var v = matrix.columns[positions[k]][i];
          if (!Number.isNaN(v)) {
            total += v;
            seen = true;
          }
        }
        sum[i] = seen ? total : NaN;
      }
      outColumns.push(sum);
      merged.set(newName, positions.map(function (p) { return results[p].original; }));
    });

    var out = { indexName: matrix.indexName, sampleIds: matrix.sampleIds, species: outNames, columns: outColumns };
    var report = {
      mapping: mapping,
      nSamples: nRows,
      columns: results,
      merged: merged,
      nOutputColumns: outNames.length,
    };
    return { matrix: out, report: report };
  }

  // ---------- report helpers (ConversionReport) ----------

  function count(report, status) {
    return report.columns.filter(function (c) { return c.status === status; }).length;
  }
  function countMatch(report, match) {
    return report.columns.filter(function (c) { return c.match === match; }).length;
  }
  function nFound(report) {
    return report.columns.length - count(report, NOT_FOUND);
  }
  function nMergedColumns(report) {
    var total = 0;
    report.merged.forEach(function (v) { total += v.length; });
    return total;
  }
  function caseOnlyDuplicates(report) {
    var groups = new Map();
    var seen = new Set();
    report.columns.forEach(function (c) {
      if (seen.has(c.newName)) return;
      seen.add(c.newName);
      var key = c.newName.toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c.newName);
    });
    return Array.from(groups.values()).filter(function (names) { return names.length > 1; });
  }

  // ---------- number formatting (pandas to_csv with float_format="%.15g") ----------

  // Same as Python's "%.15g": 15 significant digits, exact halfway cases rounded to even.
  function formatG15(x) {
    if (Number.isNaN(x)) return "";
    if (x === Infinity) return "inf";
    if (x === -Infinity) return "-inf";
    if (x === 0) return Object.is(x, -0) ? "-0" : "0";

    var negative = x < 0;
    var full = Math.abs(x).toExponential(100); // (near-)exact decimal expansion
    var parts = full.split("e");
    var exp = parseInt(parts[1], 10);
    var all = parts[0].replace(".", "");
    var digits = all.slice(0, 15).split("").map(Number);
    var rest = all.slice(15);

    var roundUp = rest[0] > "5" || (rest[0] === "5" && (/[1-9]/.test(rest.slice(1)) || digits[14] % 2 === 1));
    if (roundUp) {
      var k = 14;
      while (k >= 0 && digits[k] === 9) {
        digits[k] = 0;
        k -= 1;
      }
      if (k < 0) {
        digits.unshift(1);
        digits.pop();
        exp += 1;
      } else {
        digits[k] += 1;
      }
    }

    var text;
    if (exp < -4 || exp >= 15) {
      var mantissa = (digits[0] + "." + digits.slice(1).join("")).replace(/\.?0+$/, "");
      var expDigits = String(Math.abs(exp));
      if (expDigits.length < 2) expDigits = "0" + expDigits;
      text = mantissa + "e" + (exp < 0 ? "-" : "+") + expDigits;
    } else {
      var str = digits.join("");
      if (exp < 0) {
        text = "0." + "0".repeat(-exp - 1) + str;
      } else {
        text = str.slice(0, exp + 1) + "." + str.slice(exp + 1);
      }
      if (text.indexOf(".") >= 0) text = text.replace(/\.?0+$/, "");
    }
    return negative ? "-" + text : text;
  }

  function formatValue(x) {
    if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x);
    return formatG15(x);
  }

  function csvField(s) {
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function writeMatrix(out) {
    var lines = [];
    lines.push([out.indexName].concat(out.species).map(csvField).join(","));
    for (var i = 0; i < out.sampleIds.length; i++) {
      var cells = [csvField(out.sampleIds[i])];
      for (var j = 0; j < out.columns.length; j++) cells.push(formatValue(out.columns[j][i]));
      lines.push(cells.join(","));
    }
    return lines.join("\n") + "\n";
  }

  // ---------- summary (core.format_summary) ----------

  // Python's f"{v:.2f}" rounds exact ties to even; JS toFixed rounds them up.
  function fixed2(v) {
    var exact = v.toFixed(20);
    var dot = exact.indexOf(".");
    var tail = exact.slice(dot + 3);
    if (tail[0] === "5" && /^0*$/.test(tail.slice(1))) {
      var truncated = exact.slice(0, dot + 3);
      var lastDigit = parseInt(truncated[truncated.length - 1], 10);
      if (lastDigit % 2 === 0) return truncated;
    }
    return v.toFixed(2);
  }

  function pct(part, whole) {
    return whole ? fixed2((100.0 * part) / whole) + "%" : "n/a";
  }

  function formatSummary(report, inputName, outputName, runTime) {
    var m = report.mapping;
    var n = report.columns.length;
    var found = nFound(report);
    var lines = ["Cross Annotator summary", "=======================", ""];
    if (runTime) lines.push("Date                      : " + runTime);
    if (inputName) lines.push("Input file                : " + inputName);
    if (outputName) lines.push("Output file               : " + outputName);
    lines.push(
      "Source -> target          : " + m.sourceDb + " -> " + m.targetDb + "  (" + m.seqType + ")",
      "Mapping file              : " + m.fileName,
      "Samples (rows)            : " + report.nSamples,
      "",
      "Input species (columns)   : " + n,
      "Found in mapping file     : " + found + "  (" + pct(found, n) + ")",
      "  - exact name match      : " + countMatch(report, "exact"),
      "  - match ignoring case   : " + countMatch(report, "ignore_case"),
      "Converted to a new name   : " + count(report, CONVERTED),
      "Case only (name kept)     : " + count(report, CASE_ONLY),
      "Found, name unchanged     : " + count(report, UNCHANGED),
      "Not found (name kept)     : " + count(report, NOT_FOUND),
      "Percentage converted      : " + pct(count(report, CONVERTED), n),
      "Merged (same target name) : " + nMergedColumns(report) + " columns -> " + report.merged.size,
      "Output unique species     : " + report.nOutputColumns
    );
    if (count(report, CASE_ONLY)) {
      lines.push(
        "",
        "Note: 'Case only' species have the same name in the target database, written",
        "with different upper/lower case. They keep the spelling used in the input."
      );
    }
    if (m.seqType === "WGS") {
      lines.push(
        "",
        "Note: the WGS mapping files list only species whose names differ between",
        "the two databases. A species that is not found keeps its name."
      );
    }

    var rule = "----------------------------------------";
    if (report.merged.size) {
      lines.push("", "Merged columns (" + report.merged.size + ")", rule);
      report.merged.forEach(function (originals, newName) {
        lines.push(newName + " = " + originals.join(" + "));
      });
    }

    var caseDups = caseOnlyDuplicates(report);
    if (caseDups.length) {
      lines.push(
        "",
        "Warning: output names that differ only in upper/lower case (" + caseDups.length + ")",
        rule,
        "These were NOT merged. Check whether they are the same species."
      );
      caseDups.forEach(function (names) { lines.push(names.join("  ")); });
    }

    var converted = report.columns.filter(function (c) { return c.status === CONVERTED; });
    if (converted.length) {
      lines.push("", "Converted names (" + converted.length + ")", rule);
      converted.forEach(function (c) {
        var note = c.match === "ignore_case" ? "  (matched ignoring case)" : "";
        lines.push(c.original + " -> " + c.newName + note);
      });
    }

    var notFound = report.columns.filter(function (c) { return c.status === NOT_FOUND; });
    if (notFound.length) {
      lines.push("", "Not found in mapping file, name kept (" + notFound.length + ")", rule);
      notFound.forEach(function (c) { lines.push(c.original); });
    }

    return lines.join("\n") + "\n";
  }

  // ---------- file names (cli.py) ----------

  function stem(fileName) {
    var dot = fileName.lastIndexOf(".");
    return dot > 0 ? fileName.slice(0, dot) : fileName;
  }
  function defaultOutputName(inputName) {
    return stem(inputName) + "_converted.csv";
  }
  function summaryNameFor(outputName) {
    return stem(outputName) + "_summary.txt";
  }

  var api = {
    SEQ_TYPES: SEQ_TYPES,
    DATABASES: DATABASES,
    DATABASE_LABELS: DATABASE_LABELS,
    MAPPING_FILES: MAPPING_FILES,
    CONVERTED: CONVERTED,
    CASE_ONLY: CASE_ONLY,
    UNCHANGED: UNCHANGED,
    NOT_FOUND: NOT_FOUND,
    InputError: InputError,
    mappingFile: mappingFile,
    loadMapping: loadMapping,
    readMatrix: readMatrix,
    convert: convert,
    count: count,
    nMergedColumns: nMergedColumns,
    writeMatrix: writeMatrix,
    formatSummary: formatSummary,
    formatValue: formatValue,
    defaultOutputName: defaultOutputName,
    summaryNameFor: summaryNameFor,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CrossAnnotator = api;
})(typeof window !== "undefined" ? window : this);
