const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { parentPort, workerData } = require("worker_threads");
const ffmpegPath = require("ffmpeg-static");
const wav = require("node-wav");
const pitchfinder = require("pitchfinder");
const fft = require("fft-js").fft;
const fftUtil = require("fft-js").util;

const modeling = require("@jscad/modeling");
const { serialize } = require("@jscad/io").stlSerializer;
const { cylinder, cuboid } = modeling.primitives;
const { subtract, union } = modeling.booleans;
const { translate, rotateZ, rotateX, scale } = modeling.transforms;
const { path2 } = modeling.geometries;
const { vectorText } = modeling.text;
const { extrudeRectangular } = modeling.extrusions;
const { measureBoundingBox } = modeling.measurements;

const NOTE_NAMES = [
  "D6",
  "C6",
  "B5",
  "A5",
  "G5",
  "F5",
  "E5",
  "D5",
  "C5",
  "B4",
  "A4",
  "G4",
  "E4",
  "D4",
  "C4",
  "G3"
];

const NOTE_PIN_KEY = [
  [56.9, 58.1],
  [55.7, 56.9],
  [54.11, 55.31],
  [51.315, 52.515],
  [48.555, 49.755],
  [45.825, 47.025],
  [43, 44.2],
  [40.225, 41.425],
  [37.425, 38.625],
  [36.225, 37.425],
  [34.71, 35.91],
  [33.51, 34.71],
  [31.89, 33.09],
  [30.69, 31.89],
  [29.15, 30.35],
  [27.95, 29.15]
];

const TRACK_INNER_RADII = [
  28.15, 30.89, 33.71, 36.425, 39.225, 42, 44.825, 47.555, 50.315, 53.11, 55.9
];

const GEOM = {
  hStockSingle: 3.0,
  hStockDouble: 4.75,
  rStock: 60.58,
  oDrive: 21.765,
  rDrive: 1.565,
  hInset: 1.5,
  rInset: 25.6,
  hGroove: 1.5,
  overlap: 0.2,
  rCenter: 3.25,
  segments: 160
};

const TIMING = {
  targetSeconds: 36.0,
  maxTempoAdjust: 0.05,
  maxGapSeconds: 3.6
};

const NOTE_TO_MIDI = {
  C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5,
  "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11
};

function postProgress(value) {
  parentPort.postMessage({ type: "progress", value });
}

function postStage(value) {
  parentPort.postMessage({ type: "stage", value });
}

function sanitizeLabel(text) {
  if (!text) return "";
  return String(text);
}

function noteNameToMidi(name) {
  const match = /^([A-G]#?)(-?\d+)$/.exec(name);
  if (!match) return null;
  const pitch = NOTE_TO_MIDI[match[1]];
  const octave = parseInt(match[2], 10);
  return (octave + 1) * 12 + pitch;
}

const ALLOWED_MIDI = NOTE_NAMES.map(noteNameToMidi);

function computeBestTranspose(notes) {
  if (!notes.length) return 0;
  let best = { shift: 0, score: Infinity, hits: -1, absShift: Infinity };
  for (let shift = -12; shift <= 12; shift++) {
    let total = 0;
    let inRange = 0;
    for (const n of notes) {
      const mapped = mapMidiToAllowed(n.midi + shift);
      total += Math.abs((n.midi + shift) - mapped.midi);
      if (mapped.samePitchClass) inRange++;
    }
    const absShift = Math.abs(shift);
    if (
      total < best.score ||
      (total === best.score && inRange > best.hits) ||
      (total === best.score && inRange === best.hits && absShift < best.absShift)
    ) {
      best = { shift, score: total, hits: inRange, absShift };
    }
  }
  return best.shift;
}

function mapMidiToAllowed(midi) {
  const pitchClass = ((midi % 12) + 12) % 12;
  let bestSame = null;
  for (let i = 0; i < ALLOWED_MIDI.length; i++) {
    if (ALLOWED_MIDI[i] % 12 === pitchClass) {
      const diff = Math.abs(ALLOWED_MIDI[i] - midi);
      if (!bestSame || diff < bestSame.diff) {
        bestSame = { idx: i, midi: ALLOWED_MIDI[i], diff };
      }
    }
  }
  if (bestSame) return { ...bestSame, samePitchClass: true };

  let best = null;
  for (let i = 0; i < ALLOWED_MIDI.length; i++) {
    const diff = Math.abs(ALLOWED_MIDI[i] - midi);
    if (!best || diff < best.diff || (diff === best.diff && ALLOWED_MIDI[i] < best.midi)) {
      best = { idx: i, midi: ALLOWED_MIDI[i], diff };
    }
  }
  return { ...best, samePitchClass: false };
}

function computeTimingScale(duration) {
  const { targetSeconds, maxTempoAdjust, maxGapSeconds } = TIMING;
  if (duration <= 0) return { scale: 1, gap: targetSeconds };

  if (duration > targetSeconds) {
    const ideal = targetSeconds / duration;
    const minScale = 1 - maxTempoAdjust;
    const scale = ideal < minScale ? ideal : minScale;
    return { scale, gap: 0 };
  }

  const ideal = targetSeconds / duration;
  const maxScale = 1 + maxTempoAdjust;
  let scale = Math.min(ideal, maxScale);
  let gap = targetSeconds - duration * scale;

  if (gap > maxGapSeconds) {
    const scale2 = (targetSeconds - maxGapSeconds) / duration;
    if (scale2 > scale) {
      scale = scale2;
      gap = targetSeconds - duration * scale;
    }
  }

  return { scale, gap: Math.max(0, gap) };
}

function getGeom(includeBottomGrooves) {
  return {
    ...GEOM,
    hStock: includeBottomGrooves ? GEOM.hStockDouble : GEOM.hStockSingle
  };
}

function createBlankDisc(includeBottomGrooves) {
  const g = getGeom(includeBottomGrooves);
  const stock = cylinder({ height: g.hStock, radius: g.rStock, segments: g.segments, center: [0, 0, g.hStock / 2] });

  const topCut = translate(
    [0, 0, g.hStock - g.hInset + g.overlap + (g.hInset + g.overlap) / 2],
    cylinder({ height: g.hInset + g.overlap, radius: g.rInset, segments: g.segments, center: [0, 0, 0] })
  );

  const bottomCut = translate(
    [0, 0, -g.overlap + (g.hInset + g.overlap) / 2],
    cylinder({ height: g.hInset + g.overlap, radius: g.rInset, segments: g.segments, center: [0, 0, 0] })
  );

  const centerHole = cylinder({ height: g.hStock + 1, radius: g.rCenter, segments: g.segments, center: [0, 0, g.hStock / 2] });

  const driveHoles = [
    translate([0, g.oDrive, g.hStock / 2], cylinder({ height: g.hStock + 1, radius: g.rDrive, segments: g.segments, center: [0, 0, 0] })),
    translate([0, -g.oDrive, g.hStock / 2], cylinder({ height: g.hStock + 1, radius: g.rDrive, segments: g.segments, center: [0, 0, 0] })),
    translate([g.oDrive, 0, g.hStock / 2], cylinder({ height: g.hStock + 1, radius: g.rDrive, segments: g.segments, center: [0, 0, 0] })),
    translate([-g.oDrive, 0, g.hStock / 2], cylinder({ height: g.hStock + 1, radius: g.rDrive, segments: g.segments, center: [0, 0, 0] }))
  ];

  const groovesTop = TRACK_INNER_RADII.map((inner) => {
    const ring = subtract(
      cylinder({ height: g.hGroove + g.overlap, radius: inner + 2, segments: g.segments, center: [0, 0, 0] }),
      cylinder({ height: g.hGroove + g.overlap, radius: inner, segments: g.segments, center: [0, 0, 0] })
    );
    return translate([0, 0, g.hStock - g.hGroove / 2], ring);
  });

  const cutouts = [topCut, bottomCut, centerHole, ...driveHoles, ...groovesTop];

  return subtract(stock, union(...cutouts));
}

function buildCurvedLabel(text, side, hStock) {
  const label = sanitizeLabel(text);
  if (!label) return null;

  const fontHeight = 4.6;
  const strokeSize = 0.55;
  const arcRadius = Math.min(15.5, GEOM.rInset - 8.0);

  const glyphs = [];
  for (const ch of label) {
    if (ch === " ") {
      glyphs.push({ char: ch, width: fontHeight * 0.6, geom: null });
      continue;
    }
    const lines = vectorText({ xOffset: 0, yOffset: 0, height: fontHeight }, ch);
    const strokes = lines
      .filter((line) => line.length >= 2)
      .map((line) => {
        const p = path2.fromPoints({}, line);
        return extrudeRectangular({ height: 0.6, size: strokeSize }, p);
      });
    if (!strokes.length) {
      glyphs.push({ char: ch, width: fontHeight * 0.6, geom: null });
      continue;
    }
    let g = union(...strokes);
    const bbox = measureBoundingBox(g);
    const width = bbox[1][0] - bbox[0][0];
    const height = bbox[1][1] - bbox[0][1];
    g = translate([-bbox[0][0] - width / 2, -bbox[0][1] - height / 2, 0], g);
    glyphs.push({ char: ch, width, geom: g });
  }

  const spacing = 1.0;
  const totalWidth = glyphs.reduce((sum, g) => sum + g.width + spacing, 0);
  const maxArc = Math.PI * 1.4;
  const scaleFactor = Math.min(1, (maxArc * arcRadius) / totalWidth);

  let cursor = -((totalWidth * scaleFactor) / 2);
  const parts = [];
  for (const g of glyphs) {
    const advance = (g.width + spacing) * scaleFactor;
    if (g.geom) {
      let glyph = scale([scaleFactor, scaleFactor, 1], g.geom);
      const angle = -((cursor + advance / 2) / arcRadius);
      glyph = translate([0, arcRadius, 0], glyph);
      glyph = rotateZ(angle, glyph);
      glyph = rotateZ(-Math.PI / 2, glyph);
      parts.push(glyph);
    }
    cursor += advance;
  }

  if (!parts.length) return null;
  let text3d = union(...parts);

  if (side === "B") {
    text3d = rotateZ(Math.PI, text3d);
    text3d = rotateX(Math.PI, text3d);
    return translate([0, 0, 0], text3d);
  }

  text3d = rotateZ(Math.PI, text3d);
  return translate([0, 0, hStock - 0.1], text3d);
}

function createPin(inner, outer, angleRad, side, includeBottomGrooves) {
  const g = getGeom(includeBottomGrooves);
  const sizeX = outer - inner;
  const sizeY = 0.8;
  const sizeZ = g.hGroove + g.overlap;
  let pin = cuboid({
    size: [sizeX, sizeY, sizeZ],
    center: [sizeX / 2, sizeY / 2, sizeZ / 2]
  });
  if (side === "B") {
    pin = translate([inner, -0.5, -g.overlap], pin);
  } else {
    pin = translate([inner, -0.5, g.hStock - g.hGroove - g.overlap], pin);
  }
  pin = rotateZ(angleRad, pin);
  return pin;
}

async function buildRecordAsync(notesA, notesB, labelA, labelB) {
  const hasBottom = false;
  const g = getGeom(hasBottom);
  const blank = createBlankDisc(hasBottom);
  if (!notesA.length && !notesB.length) return blank;

  const pinsA = notesA.map((n) => createPin(n.inner, n.outer, n.angleRad, "A", hasBottom));
  const labelGeomA = buildCurvedLabel(labelA, "A", g.hStock);
  const pins = [
    ...pinsA,
    ...(labelGeomA ? [labelGeomA] : [])
  ];
  const batchSize = Math.max(50, Math.floor(pins.length / 6));

  let current = blank;
  const totalBatches = Math.ceil(pins.length / batchSize);
  for (let i = 0; i < totalBatches; i++) {
    const slice = pins.slice(i * batchSize, (i + 1) * batchSize);
    current = union(current, ...slice);
    const pct = 70 + Math.floor(((i + 1) / totalBatches) * 15);
    postProgress(pct);
    await new Promise((resolve) => setImmediate(resolve));
  }

  return current;
}

function hzToMidi(freq) {
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

function limitDensity(events, maxNotesPerSlice, sliceMs) {
  const buckets = new Map();
  const sliceSec = sliceMs / 1000;
  for (const e of events) {
    const idx = Math.floor(e.time / sliceSec);
    if (!buckets.has(idx)) buckets.set(idx, []);
    buckets.get(idx).push(e);
  }

  const out = [];
  for (const list of buckets.values()) {
    list.sort((a, b) => (b.amp || 0) - (a.amp || 0));
    out.push(...list.slice(0, maxNotesPerSlice));
  }
  return out;
}

async function decodeAudioToMonoWav(buffer, startSeconds, durationSeconds) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-audio-"));
  const inputPath = path.join(tmpDir, "input");
  const outputPath = path.join(tmpDir, "output.wav");
  fs.writeFileSync(inputPath, buffer);

  const args = [
    "-y",
    "-i", inputPath,
    "-ac", "1",
    "-ar", "44100",
    "-vn",
    "-f", "wav",
    outputPath
  ];

  await new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, (err) => {
      if (err) return reject(err);
      return resolve();
    });
  });

  const wavBuffer = fs.readFileSync(outputPath);
  const decoded = wav.decode(wavBuffer);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const channel = decoded.channelData[0];
  const sampleRate = decoded.sampleRate;
  const start = Math.max(0, Math.floor(startSeconds * sampleRate));
  const length = Math.min(channel.length - start, Math.floor(durationSeconds * sampleRate));
  const slice = channel.slice(start, start + length);
  return { samples: slice, sampleRate };
}

async function extractMonophonic(samples, sampleRate) {
  const detectorA = pitchfinder.YIN({ sampleRate, threshold: 0.05 });
  const detectorB = pitchfinder.AMDF({ sampleRate });
  const frameSize = 1024;
  const hop = 256;
  const events = [];

  for (let i = 0; i + frameSize < samples.length; i += hop) {
    const frame = samples.slice(i, i + frameSize);
    let freq = detectorA(frame);
    if (!freq) freq = detectorB(frame);
    if (freq && freq > 60 && freq < 1800) {
      events.push({
        time: i / sampleRate,
        midi: hzToMidi(freq),
        amp: 1
      });
    }
    if (i % (hop * 200) === 0) {
      postProgress(40 + Math.floor((i / samples.length) * 20));
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return limitDensity(events, 2, 80);
}

async function extractPolyphonic(samples, sampleRate) {
  const frameSize = 1024;
  const hop = 256;
  const events = [];
  const maxPeaks = 5;

  for (let i = 0; i + frameSize < samples.length; i += hop) {
    const frame = samples.slice(i, i + frameSize);
    const phasors = fft(frame);
    const mags = fftUtil.fftMag(phasors);

    const peaks = [];
    for (let bin = 5; bin < mags.length / 2; bin++) {
      const mag = mags[bin];
      if (!mag) continue;
      if (peaks.length < maxPeaks) {
        peaks.push({ bin, mag });
      } else {
        peaks.sort((a, b) => b.mag - a.mag);
        if (mag > peaks[peaks.length - 1].mag) {
          peaks[peaks.length - 1] = { bin, mag };
        }
      }
    }

    peaks.sort((a, b) => b.mag - a.mag);
    for (const p of peaks) {
      const freq = (p.bin * sampleRate) / frameSize;
      if (freq < 50 || freq > 2000) continue;
      events.push({ time: i / sampleRate, midi: hzToMidi(freq), amp: p.mag });
    }

    if (i % (hop * 200) === 0) {
      postProgress(40 + Math.floor((i / samples.length) * 20));
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return limitDensity(events, 5, 80);
}

async function run() {
  try {
    const { audioBuffer, mode, startSeconds, durationSeconds, labelA } = workerData;

    postStage("parse");
    postProgress(8);

    const duration = Math.max(6, Math.min(60, Number(durationSeconds) || 36));
    const { samples, sampleRate } = await decodeAudioToMonoWav(audioBuffer, startSeconds, duration);

    postStage("map");
    postProgress(35);

    let events = [];
    if (mode === "poly") {
      events = await extractPolyphonic(samples, sampleRate);
    } else {
      events = await extractMonophonic(samples, sampleRate);
    }

    const sourceDuration = samples.length / sampleRate;
    const { scale, gap } = computeTimingScale(sourceDuration);
    const transpose = computeBestTranspose(events);

    const target = TIMING.targetSeconds;
    const mapped = events.map((e) => {
      const scaledTime = e.time * scale;
      if (scaledTime < 0 || scaledTime > target) return null;
      const mappedNote = mapMidiToAllowed(e.midi + transpose);
      const [inner, outer] = NOTE_PIN_KEY[mappedNote.idx];
      const angleRad = (scaledTime / target) * Math.PI * 2;
      return { inner, outer, angleRad };
    }).filter(Boolean);

    postStage("build");
    postProgress(70);
    const geom = await buildRecordAsync(mapped, [], labelA, null);

    postStage("serialize");
    postProgress(90);
    const stlData = serialize({ binary: true }, geom);
    const buffer = Buffer.concat(stlData.map((part) => Buffer.from(part)));
    if (buffer.length <= 84) {
      parentPort.postMessage({ type: "error", error: "STL generation failed (empty model)." });
      return;
    }

    postStage("send");
    postProgress(98);
    parentPort.postMessage({
      type: "result",
      buffer,
      scale,
      transpose,
      gap,
      totalNotes: mapped.length,
      outOfRangePct: 0,
      sourceDuration: Math.round(sourceDuration)
    });
  } catch (err) {
    parentPort.postMessage({ type: "error", error: "Failed to convert audio." });
  }
}

run();
