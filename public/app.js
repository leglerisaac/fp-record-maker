const form = document.getElementById("uploadForm");
const audioForm = document.getElementById("audioForm");
const statusEl = document.getElementById("status");
const fileLabel = document.getElementById("fileLabel");
const fileLabelB = document.getElementById("fileLabelB");
const clearA = document.getElementById("clearA");
const clearB = document.getElementById("clearB");
const dropzone = document.getElementById("dropzone");
const summaryEl = document.getElementById("summary");

const audioLabel = document.getElementById("audioLabel");
const clearAudio = document.getElementById("clearAudio");
const audioMode = document.getElementById("audioMode");
const audioStart = document.getElementById("audioStart");
const audioDurationInput = document.getElementById("audioDuration");
const audioPlay = document.getElementById("audioPlay");
const waveCanvas = document.getElementById("waveCanvas");
const waveSelection = document.getElementById("waveSelection");
const waveWrap = document.querySelector(".wave-wrap");
const playhead = document.getElementById("playhead");

const progressEl = document.getElementById("progress");
const progressBar = progressEl.querySelector(".bar");
const progressLabel = progressEl.querySelector(".label");
const activityEl = document.getElementById("activity");
const activityText = document.getElementById("activityText");
const stepsEl = document.getElementById("steps");
const stepItems = Array.from(stepsEl.querySelectorAll("li"));

const stageOrder = ["parse", "map", "build", "serialize", "send"];
const stageLabelsMidi = {
  parse: "Parsing MIDI...",
  map: "Mapping notes...",
  build: "Building disc geometry...",
  serialize: "Serializing STL...",
  send: "Sending download..."
};
const stageLabelsAudio = {
  parse: "Parsing audio...",
  map: "Extracting notes...",
  build: "Building disc geometry...",
  serialize: "Serializing STL...",
  send: "Sending download..."
};
let stageLabels = stageLabelsMidi;
const stepTextMidi = {
  parse: "Parsing MIDI",
  map: "Mapping notes",
  build: "Building disc geometry",
  serialize: "Serializing STL",
  send: "Sending download"
};
const stepTextAudio = {
  parse: "Parsing audio",
  map: "Extracting notes",
  build: "Building disc geometry",
  serialize: "Serializing STL",
  send: "Sending download"
};

const activityPhrases = [
  "Placing pins...",
  "Carving grooves...",
  "Shaping the disc...",
  "Optimizing geometry...",
  "Packing STL..."
];
let activityTimer = null;

let audioDuration = 0;
let audioStartSeconds = 0;
let selectionWidth = 0;
let audioBuffer = null;
let playing = false;
let playbackTimer = null;
let playheadTimer = null;
let audioCtx = null;
let audioSource = null;

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

function setSummary(text) {
  if (!text) {
    summaryEl.classList.remove("active");
    summaryEl.textContent = "";
    return;
  }
  summaryEl.textContent = text;
  summaryEl.classList.add("active");
}

const fileInputs = form.querySelectorAll("input[type=file]");
const audioInput = audioForm.querySelector("input[type=file]");

function updateFileUI() {
  const fileA = fileInputs[0].files[0];
  const fileB = fileInputs[1].files[0];
  fileLabel.textContent = fileA ? fileA.name : "Select MIDI (Side A)";
  fileLabelB.textContent = fileB ? fileB.name : "Select MIDI (Side B, optional)";
  clearA.classList.toggle("visible", Boolean(fileA));
  clearB.classList.toggle("visible", Boolean(fileB));
}

function updateAudioUI() {
  const file = audioInput.files[0];
  audioLabel.textContent = file ? file.name : "Select Audio (MP3/MP4/WAV)";
  clearAudio.classList.toggle("visible", Boolean(file));
  waveWrap.classList.toggle("active", Boolean(file));
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

["dragenter", "dragover"].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  });
});

dropzone.addEventListener("drop", (e) => {
  const files = Array.from(e.dataTransfer.files).filter((f) => /\.mid(i)?$/i.test(f.name));
  if (!files.length) return;
  const dtA = new DataTransfer();
  dtA.items.add(files[0]);
  fileInputs[0].files = dtA.files;

  if (files[1]) {
    const dtB = new DataTransfer();
    dtB.items.add(files[1]);
    fileInputs[1].files = dtB.files;
  } else {
    fileInputs[1].value = "";
  }
  updateFileUI();
});

audioInput.addEventListener("change", updateAudioUI);
clearAudio.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  audioInput.value = "";
  audioBuffer = null;
  updateAudioUI();
});

function drawWaveform(buffer) {
  const ctx = waveCanvas.getContext("2d");
  const { width, height } = waveCanvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f5e8db";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#c07a55";
  ctx.lineWidth = 1;

  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / width));
  const amp = height / 2;
  ctx.beginPath();
  for (let i = 0; i < width; i++) {
    const slice = data.slice(i * step, (i + 1) * step);
    let min = 1;
    let max = -1;
    for (let j = 0; j < slice.length; j++) {
      const v = slice[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.moveTo(i, (1 + min) * amp);
    ctx.lineTo(i, (1 + max) * amp);
  }
  ctx.stroke();
}

function selectionDuration() {
  const val = Number(audioDurationInput.value || 36);
  return Math.max(6, Math.min(60, val));
}

function updateSelectionUI() {
  if (!audioDuration) return;
  const wrapWidth = waveWrap.clientWidth;
  const selectionSeconds = Math.min(selectionDuration(), audioDuration);
  selectionWidth = (selectionSeconds / audioDuration) * wrapWidth;
  const leftPx = (audioStartSeconds / audioDuration) * wrapWidth;
  waveSelection.style.width = `${selectionWidth}px`;
  waveSelection.style.left = `${Math.min(leftPx, wrapWidth - selectionWidth)}px`;
  audioStart.value = audioStartSeconds.toFixed(1);
}

let dragging = false;
let resizing = null;
let dragOffset = 0;

waveSelection.addEventListener("mousedown", (e) => {
  const rect = waveSelection.getBoundingClientRect();
  const offsetX = e.clientX - rect.left;
  if (offsetX < 10) {
    resizing = "left";
  } else if (offsetX > rect.width - 10) {
    resizing = "right";
  } else {
    dragging = true;
    dragOffset = offsetX;
  }
  waveSelection.style.cursor = "grabbing";
});

window.addEventListener("mouseup", () => {
  dragging = false;
  resizing = null;
  waveSelection.style.cursor = "grab";
});

window.addEventListener("mousemove", (e) => {
  if ((!dragging && !resizing) || !audioDuration) return;
  const rect = waveWrap.getBoundingClientRect();
  const wrapWidth = rect.width;
  let left = parseFloat(waveSelection.style.left) || 0;
  let width = selectionWidth;
  const mouseX = e.clientX - rect.left;

  if (dragging) {
    left = mouseX - dragOffset;
    left = Math.max(0, Math.min(left, wrapWidth - width));
  } else if (resizing === "left") {
    const newLeft = Math.min(Math.max(0, mouseX), left + width - 20);
    width = width + (left - newLeft);
    left = newLeft;
  } else if (resizing === "right") {
    width = Math.min(wrapWidth - left, Math.max(20, mouseX - left));
  }

  selectionWidth = width;
  waveSelection.style.left = `${left}px`;
  waveSelection.style.width = `${width}px`;
  audioStartSeconds = (left / wrapWidth) * audioDuration;
  const seconds = (width / wrapWidth) * audioDuration;
  audioDurationInput.value = seconds.toFixed(1);
  audioStart.value = audioStartSeconds.toFixed(1);
});

audioDurationInput.addEventListener("change", () => {
  updateSelectionUI();
});

audioStart.addEventListener("change", () => {
  const val = Number(audioStart.value || 0);
  audioStartSeconds = Math.max(0, Math.min(val, Math.max(0, audioDuration - selectionDuration())));
  updateSelectionUI();
});

async function loadAudioWave(file) {
  if (!file) return;
  const arrayBuffer = await file.arrayBuffer();
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  audioDuration = audioBuffer.duration;
  audioStartSeconds = 0;
  drawWaveform(audioBuffer);
  updateSelectionUI();
}

audioInput.addEventListener("change", () => {
  updateAudioUI();
  const file = audioInput.files[0];
  if (file) loadAudioWave(file);
});

function stopPlayback() {
  if (audioSource) {
    audioSource.stop();
    audioSource.disconnect();
    audioSource = null;
  }
  playing = false;
  audioPlay.textContent = "Play Selection";
  playhead.classList.remove("active");
  clearInterval(playheadTimer);
  clearTimeout(playbackTimer);
}

audioPlay.addEventListener("click", async () => {
  if (!audioBuffer) return;
  if (playing) {
    stopPlayback();
    return;
  }
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  audioSource = audioCtx.createBufferSource();
  audioSource.buffer = audioBuffer;
  audioSource.connect(audioCtx.destination);
  const duration = Math.min(selectionDuration(), audioDuration - audioStartSeconds);
  const startTime = audioCtx.currentTime;
  audioSource.start(0, audioStartSeconds, duration);
  playing = true;
  audioPlay.textContent = "Stop Playback";
  playhead.classList.add("active");

  const wrapWidth = waveWrap.clientWidth;
  const leftPx = (audioStartSeconds / audioDuration) * wrapWidth;
  const widthPx = (duration / audioDuration) * wrapWidth;

  clearInterval(playheadTimer);
  playheadTimer = setInterval(() => {
    const elapsed = audioCtx.currentTime - startTime;
    const clamped = Math.min(duration, Math.max(0, elapsed));
    const x = leftPx + (clamped / duration) * widthPx;
    playhead.style.left = `${x}px`;
  }, 50);

  clearTimeout(playbackTimer);
  playbackTimer = setTimeout(() => {
    stopPlayback();
  }, duration * 1000);

  audioSource.onended = () => {
    stopPlayback();
  };
});

async function runJob({ endpoint, formData, outputNameFallback, mode }) {
  stageLabels = mode === "audio" ? stageLabelsAudio : stageLabelsMidi;
  const stepText = mode === "audio" ? stepTextAudio : stepTextMidi;
  stepItems.forEach((li) => {
    const key = li.getAttribute("data-stage");
    if (stepText[key]) li.textContent = stepText[key];
  });
  statusEl.textContent = "Converting...";
  statusEl.className = "status working";
  progressEl.classList.add("active");
  activityEl.classList.add("active");
  stepsEl.classList.add("active");
  setSummary("");
  setProgress(0);
  setStage("parse");
  startActivityTicker();

  const jobRes = await fetch("/api/job", { method: "POST" });
  if (!jobRes.ok) throw new Error("Failed to create job.");
  const { jobId } = await jobRes.json();
  formData.append("jobId", jobId);

  const es = new EventSource(`/api/progress/${jobId}`);
  es.addEventListener("progress", (evt) => {
    const pct = Number(evt.data);
    if (!Number.isNaN(pct)) setProgress(pct);
  });
  es.addEventListener("stage", (evt) => {
    setStage(evt.data);
  });

  const res = await fetch(endpoint, { method: "POST", body: formData });
  es.close();
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Conversion failed.");
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const outputName = res.headers.get("X-Output-Name") || outputNameFallback;
  a.href = url;
  a.download = `${outputName}.stl`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  const scale = res.headers.get("X-Scale-Factor") || "";
  const transpose = res.headers.get("X-Transpose-Semites") || "";
  const gap = res.headers.get("X-Gap-Seconds") || "";
  const notes = res.headers.get("X-Total-Notes") || "";
  const oob = res.headers.get("X-Out-Of-Range") || "";
  const duration = res.headers.get("X-Source-Duration") || "";
  statusEl.textContent = `Done. Scale ${scale}, transpose ${transpose} semis, gap ${gap}s.`;
  statusEl.className = "status done";
  if (notes) {
    setSummary(`Summary: ${notes} notes, ${oob}% out-of-range, source duration ${duration}s.`);
  }
  setProgress(100);
  progressEl.classList.remove("active");
  activityEl.classList.remove("active");
  stepsEl.classList.remove("active");
  stopActivityTicker();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInputA = fileInputs[0];
  const fileInputB = fileInputs[1];
  if (!fileInputA.files.length) return;

  const data = new FormData();
  data.append("midi", fileInputA.files[0]);
  if (fileInputB.files.length) {
    data.append("midiB", fileInputB.files[0]);
  }

  const fallback = fileInputA.files[0].name.replace(/\.(mid|midi)$/i, "") || "record";
  try {
    await runJob({ endpoint: "/api/convert", formData: data, outputNameFallback: fallback, mode: "midi" });
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = "status error";
    setProgress(0);
    progressEl.classList.remove("active");
    activityEl.classList.remove("active");
    stepsEl.classList.remove("active");
    setSummary("");
    stopActivityTicker();
  }
});

audioForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!audioInput.files.length) return;

  const data = new FormData();
  data.append("audio", audioInput.files[0]);
  data.append("mode", audioMode.value);
  data.append("startSeconds", audioStartSeconds.toFixed(2));
  data.append("durationSeconds", selectionDuration().toFixed(2));

  const fallback = audioInput.files[0].name.replace(/\.(mp3|mp4|wav|m4a)$/i, "") || "record";
  try {
    await runJob({ endpoint: "/api/convert-audio", formData: data, outputNameFallback: fallback, mode: "audio" });
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = "status error";
    setProgress(0);
    progressEl.classList.remove("active");
    activityEl.classList.remove("active");
    stepsEl.classList.remove("active");
    setSummary("");
    stopActivityTicker();
  }
});
