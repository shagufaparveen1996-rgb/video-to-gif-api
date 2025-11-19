import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());

// Note: Don't use express.json() or urlencoded with multer
// Multer parses multipart/form-data automatically

const API_KEY = process.env.ES_API_KEY;

// API Key protection
app.use((req, res, next) => {
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
});

const upload = multer({
  dest: "uploads/",
  preservePath: true
});

// API endpoint: Convert video → high-quality, dynamic GIF
app.post("/convert", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).send("No video file uploaded.");

  const inputPath = req.file.path;
  const outputFile = `output_${Date.now()}.gif`;

  // Debug logs
  console.log("📦 Received size:", req.body.size, "type:", typeof req.body.size);

  // Parse inputs
  let fps = req.body.fps ? parseInt(String(req.body.fps)) : 15;
  let quality =
    req.body.quality && ["low", "medium", "high"].includes(String(req.body.quality))
      ? String(req.body.quality)
      : "medium";
  let size = req.body.size ? String(req.body.size) : "480";
  let speed = req.body.speed ? parseFloat(String(req.body.speed)) : 1.0;
  let startTime = req.body.startTime ? parseFloat(String(req.body.startTime)) : 0;
  let endTime = req.body.endTime ? parseFloat(String(req.body.endTime)) : 60;

  // Validate inputs
  if (isNaN(fps) || fps < 0 || fps > 30) fps = 15;

  let sizeNum = parseInt(size) || 480;
  if (isNaN(sizeNum) || sizeNum < 100 || sizeNum > 800) sizeNum = 480;
  size = String(sizeNum);

  if (isNaN(speed) || speed < 0.5 || speed > 2.0) speed = 1.0;
  if (isNaN(startTime) || startTime < 0) startTime = 0;
  if (isNaN(endTime) || endTime <= startTime) endTime = startTime + 60;

  const duration = Math.max(0.1, endTime - startTime);

  // Loop parsing
  let loop = true;
  if (req.body.loop !== undefined) {
    const loopValue = req.body.loop;
    if (loopValue === "0" || loopValue === 0 || loopValue === false || loopValue === "false") {
      loop = false;
    }
  }

  // Dynamic scale
  const clampedSize = Math.max(100, Math.min(800, sizeNum));
  const scale = `${clampedSize}:-1`;

  // Speed filter
  const clampedSpeed = Math.max(0.5, Math.min(2.0, speed));
  let speedFilter = "";
  if (clampedSpeed !== 1.0) {
    const setptsValue = (1.0 / clampedSpeed).toFixed(4);
    speedFilter = `setpts=${setptsValue}*PTS,`;
  }

  // Dithering
  let dither = "bayer";
  if (quality === "high") dither = "floyd_steinberg";
  if (quality === "low") dither = "bayer";

  const scaleFlags = quality === "low" ? "flags=bilinear" : "flags=lanczos";
  const palettePath = `palette_${Date.now()}.png`;

  const loopValue = loop ? "0" : "-1";
  const paletteSize = "256";
  const statsMode = quality === "low" ? "single" : "diff";

  console.log("📏 Final scale:", scale);

  const paletteFilter = speedFilter
    ? `${speedFilter}fps=${fps},scale=${scale}:${scaleFlags},palettegen=stats_mode=${statsMode}:max_colors=${paletteSize}`
    : `fps=${fps},scale=${scale}:${scaleFlags},palettegen=stats_mode=${statsMode}:max_colors=${paletteSize}`;

  const paletteFfmpeg = ffmpeg(inputPath);

  // Trim for palette
  if (startTime > 0) paletteFfmpeg.seekInput(startTime);
  if (duration > 0 && duration < 600) paletteFfmpeg.duration(duration);

  paletteFfmpeg
    .outputOptions(["-vf", paletteFilter, "-threads", "0"])
    .on("end", () => {
      const conversionFilter = speedFilter
        ? `[0:v]${speedFilter}fps=${fps},scale=${scale}:${scaleFlags}[x];[x][1:v]paletteuse=dither=${dither}`
        : `[0:v]fps=${fps},scale=${scale}:${scaleFlags}[x];[x][1:v]paletteuse=dither=${dither}`;

      console.log("🎨 Conversion filter:", conversionFilter);

      const convertFfmpeg = ffmpeg(inputPath);

      if (startTime > 0) convertFfmpeg.seekInput(startTime);
      if (duration > 0 && duration < 600) convertFfmpeg.duration(duration);

      convertFfmpeg
        .input(palettePath)
        .complexFilter(conversionFilter)
        .outputOptions(["-loop", loopValue, "-threads", "0"])
        .toFormat("gif")
        .on("error", (err) => {
          console.error("❌ FFmpeg error:", err.message);
          res.status(500).send("Video conversion failed");
          cleanup();
        })
        .on("end", () => {
          res.download(outputFile, () => cleanup());
        })
        .save(outputFile);
    })
    .on("error", (err) => {
      console.error("❌ Palette generation error:", err.message);
      res.status(500).send("Palette generation failed");
      cleanup();
    })
    .save(palettePath);

  // Cleanup temp files
  function cleanup() {
    [inputPath, outputFile, palettePath].forEach((file) => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });
  }
});

// Test route
app.get("/", (req, res) => {
  res.send("✅ Video to GIF API running successfully — use /convert endpoint");
});

// Server start
app.listen(10000, () => console.log("🚀 Server running on port 10000"));
