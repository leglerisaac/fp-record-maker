const form = document.getElementById("uploadForm");
const statusEl = document.getElementById("status");
const fileLabel = document.getElementById("fileLabel");
const fileLabelB = document.getElementById("fileLabelB");
const clearA = document.getElementById("clearA");
const clearB = document.getElementById("clearB");
const progressEl = document.getElementById("progress");
const progressBar = progressEl.querySelector(".bar");
const progressLabel = progressEl.querySelector(".label");
const activityEl = document.getElementById("activity");
const activityText = document.getElementById("activityText");
const stepsEl = document.getElementById("steps");
const stepItems = Array.from(stepsEl.querySelectorAll("li"));

const stageOrder = ["parse", "map", "build", "serialize", "send"];
const stageLabels = {
  parse: "Parsing MIDI...",
  map: "Mapping notes...",
  build: "Building disc geometry...",
  serialize: "Serializing STL...",
  send: "Sending download..."
};

const activityPhrases = [
  "Placing pins...",
  "Carving grooves...",
  "Shaping the disc...",
  "Optimizing geometry...",
  "Packing STL..."
];
let activityTimer = null;

function setProgress(value) {
  const clamped = Math.max(0, Math.min(100, value));
  progressBar.style.width = `${clamped}%`;
  progressLabel.textContent = `${Math.round(clamped)}%`;
}

function setStage(stage) {
  const idx = stageOrder.indexOf(stage);
  if (idx === -1) return;
  stepItems.forEach((li, i) => {
    li.classList.toggle("active", i === idx);
    li.classList.toggle("done", i < idx);
  });
  activityText.textContent = stageLabels[stage] || "Working...";
}

function startActivityTicker() {
  let i = 0;
  if (activityTimer) clearInterval(activityTimer);
  activityTimer = setInterval(() => {
    const msg = activityPhrases[i % activityPhrases.length];
    i += 1;
    if (!Object.values(stageLabels).includes(activityText.textContent)) {
      activityText.textContent = msg;
    }
  }, 1500);
}

function stopActivityTicker() {
  if (activityTimer) clearInterval(activityTimer);
  activityTimer = null;
}

const fileInputs = form.querySelectorAll("input[type=file]");
function updateFileUI() {
  const fileA = fileInputs[0].files[0];
  const fileB = fileInputs[1].files[0];
  fileLabel.textContent = fileA ? fileA.name : "Select MIDI (Side A)";
  fileLabelB.textContent = fileB ? fileB.name : "Select MIDI (Side B, optional)";
  clearA.classList.toggle("visible", Boolean(fileA));
  clearB.classList.toggle("visible", Boolean(fileB));
}

fileInputs[0].addEventListener("change", updateFileUI);
fileInputs[1].addEventListener("change", updateFileUI);

clearA.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  fileInputs[0].value = "";
  updateFileUI();
});

clearB.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  fileInputs[1].value = "";
  updateFileUI();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const fileInputA = fileInputs[0];
  const fileInputB = fileInputs[1];
  if (!fileInputA.files.length) return;

  const data = new FormData();

  statusEl.textContent = "Converting...";
  statusEl.className = "status working";
  progressEl.classList.add("active");
  activityEl.classList.add("active");
  stepsEl.classList.add("active");
  setProgress(0);
  setStage("parse");
  startActivityTicker();

  try {
    const jobRes = await fetch("/api/job", { method: "POST" });
    if (!jobRes.ok) throw new Error("Failed to create job.");
    const { jobId } = await jobRes.json();

    data.append("midi", fileInputA.files[0]);
    if (fileInputB.files.length) {
      data.append("midiB", fileInputB.files[0]);
    }
    data.append("jobId", jobId);

    const es = new EventSource(`/api/progress/${jobId}`);
    es.addEventListener("progress", (evt) => {
      const pct = Number(evt.data);
      if (!Number.isNaN(pct)) setProgress(pct);
    });
    es.addEventListener("stage", (evt) => {
      setStage(evt.data);
    });
    const res = await fetch("/api/convert", { method: "POST", body: data });
    es.close();
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Conversion failed.");
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const name = fileInputA.files[0].name.replace(/\.(mid|midi)$/i, "") || "record";
    a.href = url;
    a.download = `${name}.stl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    const scale = res.headers.get("X-Scale-Factor") || "";
    const transpose = res.headers.get("X-Transpose-Semites") || "";
    const gap = res.headers.get("X-Gap-Seconds") || "";
    statusEl.textContent = `Done. Scale ${scale}, transpose ${transpose} semis, gap ${gap}s.`;
    statusEl.className = "status done";
    setProgress(100);
    progressEl.classList.remove("active");
    activityEl.classList.remove("active");
    stepsEl.classList.remove("active");
    stopActivityTicker();
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = "status error";
    setProgress(0);
    progressEl.classList.remove("active");
    activityEl.classList.remove("active");
    stepsEl.classList.remove("active");
    stopActivityTicker();
  }
});
