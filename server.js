const path = require("path");
const express = require("express");
const multer = require("multer");
const { Worker } = require("worker_threads");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const jobs = new Map();

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.post("/api/job", (req, res) => {
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  jobs.set(jobId, { progress: 0, clients: new Set() });
  return res.json({ jobId });
});

app.get("/api/progress/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`);
  send("progress", job.progress);
  if (job.stage) send("stage", job.stage);
  if (Number.isFinite(job.eta)) send("eta", job.eta);

  job.clients.add(send);

  req.on("close", () => {
    job.clients.delete(send);
  });
});

function registerWorkerHandlers({ worker, res, fileA, fileB, jobId }) {
  const job = jobId ? jobs.get(jobId) : null;
  const updateProgress = (pct) => {
    if (!job) return;
    job.progress = pct;
    for (const send of job.clients) send("progress", pct);
  };
  const updateStage = (stage) => {
    if (!job) return;
    job.stage = stage;
    for (const send of job.clients) send("stage", stage);
  };
  const updateEta = (eta) => {
    if (!job) return;
    job.eta = eta;
    for (const send of job.clients) send("eta", eta);
  };

  let responded = false;

  worker.on("message", (msg) => {
    if (msg.type === "progress") updateProgress(msg.value);
    if (msg.type === "stage") updateStage(msg.value);
    if (msg.type === "eta") updateEta(msg.value);

    if (msg.type === "result" && !responded) {
      responded = true;
      const buffer = Buffer.from(msg.buffer);
      const safeName = (name) => name.replace(/[\\/:%*?"<>|]/g, "").trim();
      const nameA = safeName(path.parse(fileA.originalname).name || "record");
      const nameB = fileB ? safeName(path.parse(fileB.originalname).name || "side-b") : "";
      const outName = fileB ? `${nameA} - ${nameB}` : nameA;

      res.setHeader("Content-Type", "application/sla");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${outName}.stl"`
      );
      res.setHeader("X-Output-Name", outName);
      res.setHeader("X-Scale-Factor", msg.scale.toFixed(4));
      res.setHeader("X-Transpose-Semites", msg.transpose.toString());
      res.setHeader("X-Gap-Seconds", msg.gap.toFixed(3));
      if (msg.totalNotes != null) res.setHeader("X-Total-Notes", msg.totalNotes.toString());
      if (msg.outOfRangePct != null) res.setHeader("X-Out-Of-Range", msg.outOfRangePct.toString());
      if (msg.sourceDuration != null) res.setHeader("X-Source-Duration", msg.sourceDuration.toString());

      updateProgress(100);
      res.send(buffer);
      if (jobId) jobs.delete(jobId);
      worker.terminate();
    }

    if (msg.type === "error" && !responded) {
      responded = true;
      res.status(500).json({ error: msg.error || "Failed to convert." });
      if (jobId) jobs.delete(jobId);
      worker.terminate();
    }
  });

  worker.on("error", (err) => {
    console.error(err);
    if (!responded) {
      responded = true;
      res.status(500).json({ error: "Worker failed to convert." });
      if (jobId) jobs.delete(jobId);
    }
  });
}

app.post("/api/convert", upload.fields([{ name: "midi", maxCount: 1 }, { name: "midiB", maxCount: 1 }]), (req, res) => {
  const fileA = req.files?.midi?.[0];
  const fileB = req.files?.midiB?.[0];
  if (!fileA) {
    return res.status(400).json({ error: "No MIDI file uploaded." });
  }

  const jobId = req.body.jobId;

  const worker = new Worker(path.join(__dirname, "worker.js"), {
    workerData: {
      midiBufferA: fileA.buffer,
      midiBufferB: fileB ? fileB.buffer : null,
      labelA: path.parse(fileA.originalname).name,
      labelB: fileB ? path.parse(fileB.originalname).name : null
    }
  });

  registerWorkerHandlers({ worker, res, fileA, fileB, jobId });
});

app.post("/api/convert-audio", upload.single("audio"), (req, res) => {
  const fileA = req.file;
  if (!fileA) {
    return res.status(400).json({ error: "No audio file uploaded." });
  }
  const jobId = req.body.jobId;
  const mode = req.body.mode === "poly" ? "poly" : "mono";
  const startSeconds = Math.max(0, Number(req.body.startSeconds || 0));
  const durationSeconds = Math.max(6, Math.min(60, Number(req.body.durationSeconds || 36)));

  const worker = new Worker(path.join(__dirname, "audio_worker.js"), {
    workerData: {
      audioBuffer: fileA.buffer,
      labelA: path.parse(fileA.originalname).name,
      mode,
      startSeconds,
      durationSeconds
    }
  });

  registerWorkerHandlers({ worker, res, fileA, fileB: null, jobId });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
