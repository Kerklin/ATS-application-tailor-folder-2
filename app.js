import * as pdfjsLib from "./vendor/pdf.min.js";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.js", import.meta.url).href;

const $ = (id) => document.getElementById(id);
const DEFAULT_MODEL = { anthropic: "claude-sonnet-4-5", openai: "gpt-5" };
const MAX_FILE_MB = 10;
const KEY_STORE = "ats-api-key";
let results = {}, current = null;

/* ---------- settings ---------- */
let saved = {};
try { saved = JSON.parse(localStorage.getItem("ats-settings") || "{}"); } catch { saved = {}; }
for (const k of ["provider", "model", "lang", "style", "pages"]) if (typeof saved[k] === "string") $(k).value = saved[k];
const storedKey = localStorage.getItem(KEY_STORE);
if (storedKey) { $("apiKey").value = storedKey; $("remember").checked = true; }
$("provider").addEventListener("change", () => { $("model").value = DEFAULT_MODEL[$("provider").value]; });
$("remember").addEventListener("change", () => { if (!$("remember").checked) localStorage.removeItem(KEY_STORE); });

function saveSettings() {
  localStorage.setItem("ats-settings", JSON.stringify({
    provider: $("provider").value, model: $("model").value, lang: $("lang").value,
    style: $("style").value, pages: $("pages").value,
  }));
  if ($("remember").checked) localStorage.setItem(KEY_STORE, $("apiKey").value);
  else localStorage.removeItem(KEY_STORE);
}

/* ---------- file reading ---------- */
async function readPdf(buf) {
  const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false, enableXfa: false }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const c = await (await pdf.getPage(i)).getTextContent();
    let lastY = null;
    for (const it of c.items) {
      if (!("str" in it)) continue;
      if (lastY !== null && Math.abs(it.transform[5] - lastY) > 2) text += "\n";
      text += it.str; lastY = it.transform[5];
    }
    text += "\n\n";
  }
  return text.trim();
}

/* Minimal DOCX reader: finds word/document.xml in the ZIP and inflates it natively. */
async function readDocx(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid DOCX file");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name !== "word/document.xml") continue;
    if (usize > 50 * 1024 * 1024) throw new Error("document too large");
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = u8.subarray(start, start + csize);
    let xml;
    if (method === 0) xml = dec.decode(data);
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      xml = await new Response(stream).text();
    } else throw new Error("unsupported DOCX compression");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const lines = [];
    for (const para of doc.getElementsByTagNameNS(W, "p")) {
      let line = "";
      for (const el of para.getElementsByTagNameNS(W, "*")) {
        if (el.localName === "t") line += el.textContent;
        else if (el.localName === "tab") line += "\t";
        else if (el.localName === "br") line += "\n";
      }
      lines.push(line);
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  throw new Error("no document text found in DOCX");
}

async function readFile(file) {
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`file is over ${MAX_FILE_MB} MB`);
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "pdf") return readPdf(await file.arrayBuffer());
  if (ext === "docx") return readDocx(await file.arrayBuffer());
  if (ext === "txt" || ext === "md") return (await file.text()).trim();
  throw new Error("use PDF, DOCX or TXT");
}

function wireDrop(inputId, labelId, targetId) {
  const input = $(inputId), label = $(labelId), drop = input.parentElement;
  const handle = async (file) => {
    if (!file) return;
    label.textContent = `Reading ${file.name}…`;
    try {
      const text = await readFile(file);
      if (text.length < 50) throw new Error("almost no text found (scanned PDF?)");
      $(targetId).value = text;
      label.textContent = `✓ ${file.name}: check the extracted text below`;
    } catch (e) {
      label.textContent = `Could not read ${file.name}: ${e.message}. Paste the text instead.`;
    }
  };
  input.addEventListener("change", () => handle(input.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); handle(e.dataTransfer.files[0]); });
}
wireDrop("cvFile", "cvLabel", "cvText");
wireDrop("jdFile", "jdLabel", "jdText");

/* ---------- AI calls ---------- */
async function postJson(url, headers, body) {
  let r;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers },
                           body: JSON.stringify(body), referrerPolicy: "no-referrer" });
  } catch {
    throw new Error("network error: check your connection, or that the provider allows browser requests");
  }
  let j;
  try { j = await r.json(); } catch { throw new Error(`HTTP ${r.status}: unreadable response`); }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${String(j?.error?.message || r.statusText).slice(0, 300)}`);
  return j;
}

async function callAnthropic(key, model, prompt, web) {
  const headers = { "x-api-key": key, "anthropic-version": "2023-06-01",
                    "anthropic-dangerous-direct-browser-access": "true" };
  const messages = [{ role: "user", content: prompt }];
  const body = { model, max_tokens: 16000, messages };
  if (web) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }];
  let text = "", warn = "";
  for (let turn = 0; turn < 4; turn++) {
    const j = await postJson("https://api.anthropic.com/v1/messages", headers, body);
    text += (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    if (j.stop_reason === "pause_turn") {          // long web-search turn: let it continue
      messages.push({ role: "assistant", content: j.content });
      continue;
    }
    if (j.stop_reason === "max_tokens") warn = "Output hit the length limit and may be cut off.";
    if (j.stop_reason === "refusal") warn = "The model declined part of the request.";
    break;
  }
  return { text, warn };
}

async function callOpenAI(key, model, prompt, web) {
  const body = { model, input: prompt, max_output_tokens: 32000 };
  if (web) body.tools = [{ type: "web_search" }];
  const j = await postJson("https://api.openai.com/v1/responses", { authorization: `Bearer ${key}` }, body);
  const text = j.output_text || (j.output || []).flatMap((o) => o.content || [])
    .filter((c) => c.type === "output_text").map((c) => c.text).join("");
  const warn = j.status === "incomplete"
    ? `Output incomplete (${j.incomplete_details?.reason || "unknown reason"}) and may be cut off.` : "";
  return { text, warn };
}

/* ---------- parsing + display (text only, never HTML) ---------- */
function parse(text) {
  const out = {};
  const marks = [...text.matchAll(/^===\s*([A-Z_]+)\s*===\s*$/gm)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    out[m[1]] = text.slice(m.index + m[0].length, end).trim();
  });
  return out;
}
const clean = (s) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "").replace(/https?:\/\/\S+/g, "");

function show(key) {
  current = key;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.k === key));
  $("out").textContent = results[key] || "(empty)";
}

function render() {
  const tabs = $("tabs"); tabs.replaceChildren();
  const list = [...SECTIONS, ["RAW", "Full output"]].filter(([k]) => results[k]);
  for (const [k, label] of list) {
    const b = document.createElement("button");
    b.className = "tab ghost"; b.dataset.k = k; b.textContent = label;
    b.addEventListener("click", () => show(k));
    tabs.appendChild(b);
  }
  $("results").classList.remove("hidden");
  show(results.FIT ? "FIT" : list[0][0]);
}

function fileBase() {
  const m = (results.FILE_NAMES || "").match(/[A-Za-z0-9][A-Za-z0-9_\-]{0,60}_(CV|Resume)[A-Za-z0-9_\-]{0,40}/i);
  return m ? m[0] : "Application";
}

function download(name, content, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name.replace(/[^\w.\-]/g, "_");
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$("copyBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(results[current] || "");
    $("copyBtn").textContent = "Copied ✓";
  } catch { $("copyBtn").textContent = "Select and copy manually"; }
  setTimeout(() => ($("copyBtn").textContent = "Copy"), 1500);
});
$("dlTxt").addEventListener("click", () => download(`${current}_${fileBase()}.txt`, results[current] || "", "text/plain"));
$("dlDoc").addEventListener("click", () => {
  const esc = (results[current] || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<html><head><meta charset="utf-8"></head><body style="font-family:Calibri,Arial;font-size:11pt;white-space:pre-wrap">${esc}</body></html>`;
  download(`${current}_${fileBase()}.doc`, html, "application/msword");
});

function status(msg, cls = "", busy = false) {
  const s = $("status");
  s.className = "status " + cls;
  s.replaceChildren();
  if (busy) { const sp = document.createElement("span"); sp.className = "spin"; s.appendChild(sp); }
  s.appendChild(document.createTextNode(msg));
}

/* ---------- run ---------- */
$("run").addEventListener("click", async () => {
  const cv = $("cvText").value.trim(), jd = $("jdText").value.trim(), jdUrl = $("jdUrl").value.trim();
  const key = $("apiKey").value.trim(), provider = $("provider").value, model = $("model").value.trim();
  const web = $("web").checked;
  if (!cv) return status("Add your CV first.", "err");
  if (!jd && !(jdUrl && web)) return status("Paste the JD text, or give a link with web search on.", "err");
  if (jdUrl && !/^https:\/\//i.test(jdUrl)) return status("The vacancy link must start with https://", "err");
  if (!key) return status("Enter your API key.", "err");
  if (!/^[\w.\-:]{1,80}$/.test(model)) return status("Model name looks invalid.", "err");
  saveSettings();

  const prompt = buildPrompt({ cv, jd, jdUrl, lang: $("lang").value, style: $("style").value,
                               pages: $("pages").value, extra: $("extra").value.trim(), web });
  $("run").disabled = true;
  const t0 = Date.now();
  const tick = () => status(`Deep-dive analysis running… ${Math.round((Date.now() - t0) / 1000)}s (usually 1–4 min)`, "", true);
  tick();
  const timer = setInterval(tick, 1000);
  try {
    const { text, warn } = provider === "anthropic"
      ? await callAnthropic(key, model, prompt, web)
      : await callOpenAI(key, model, prompt, web);
    if (!text) throw new Error("empty response from the model");
    results = parse(text);
    for (const k of ["CV", "COVER_LETTER"]) if (results[k]) results[k] = clean(results[k]);
    results.RAW = text;
    render();
    const n = SECTIONS.filter(([k]) => results[k]).length;
    const ok = n === SECTIONS.length && !warn;
    status(`Done: ${n} of ${SECTIONS.length} sections. ${warn} Review everything before you submit.`, ok ? "ok" : "err");
  } catch (e) {
    status(`Error: ${e.message}`, "err");
  } finally {
    clearInterval(timer);
    $("run").disabled = false;
  }
});
