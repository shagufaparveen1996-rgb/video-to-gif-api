import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
// Note: Don't use json/urlencoded with multer - multer handles multipart/form-data automatically
// Text fields from multipart/form-data will be in req.body

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
  // Ensure text fields are parsed
  preservePath: true
});

// API endpoint: Convert video → high-quality, dynamic GIF
app.post("/convert", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).send("No video file uploaded.");

  const inputPath = req.file.path;
  const outputFile = `output_${Date.now()}.gif`;


  // Dynamic values from frontend (or defaults) - ensure we parse them correctly
  // Multer parses text fields as strings, so we need to convert them
  let fps = req.body.fps ? parseInt(String(req.body.fps)) : 15;
  let quality = (req.body.quality && ['low', 'medium', 'high'].includes(String(req.body.quality))) 
    ? String(req.body.quality) 
    : "medium";
  let size = req.body.size ? String(req.body.size) : "480";
  let speed = req.body.speed ? parseFloat(String(req.body.speed)) : 1.0;
  let startTime = req.body.startTime ? parseFloat(String(req.body.startTime)) : 0;
  let endTime = req.body.endTime ? parseFloat(String(req.body.endTime)) : 60;
  
  // Validate parsed values
  if (isNaN(fps) || fps < 0 || fps > 30) {
    console.warn("⚠️ Invalid FPS, using default 15");
    fps = 15;
  }
  
  // Validate and parse size
  const sizeNum = parseInt(size) || 480;
  if (isNaN(sizeNum) || sizeNum < 100 || sizeNum > 800) {
    console.warn("⚠️ Invalid size:", size, "using default 480");
    size = "480";
  } else {
    size = String(sizeNum);
  }
  
  if (isNaN(speed) || speed < 0.5 || speed > 2.0) {
    console.warn("⚠️ Invalid speed, using default 1.0");
    speed = 1.0;
  }
  if (isNaN(startTime) || startTime < 0) {
    console.warn("⚠️ Invalid startTime, using default 0");
    startTime = 0;
  }
  if (isNaN(endTime) || endTime <= startTime) {
    console.warn("⚠️ Invalid endTime, using default 60");
    endTime = 60;
  }
  
  const duration = Math.max(0.1, endTime - startTime);
  
  // Parse loop parameter - handle string '1'/'0', number 1/0, or boolean
  let loop = true; // Default to true
  if (req.body.loop !== undefined && req.body.loop !== null) {
    const loopValue = req.body.loop;
    if (loopValue === '0' || loopValue === 0 || loopValue === false || loopValue === 'false') {
      loop = false;
    } else if (loopValue === '1' || loopValue === 1 || loopValue === true || loopValue === 'true') {
      loop = true;
    }
  }

  // Dynamic scale - size can be any number (100-800px)
  // Size is already validated above, so we can safely use sizeNum from validation
  const clampedSize = Math.max(100, Math.min(800, sizeNum)); // Clamp between 100-800px
  const scale = `${clampedSize}:-1`;
  

  // Speed control - apply setpts filter for speed adjustment
  const clampedSpeed = Math.max(0.5, Math.min(2.0, speed)); // Clamp between 0.5x and 2x
  let speedFilter = "";
  if (clampedSpeed !== 1.0) {
    // setpts filter: 0.5x = 2.0*PTS (slower), 1.5x = 0.6667*PTS, 2x = 0.5*PTS (faster)
    const setptsValue = (1.0 / clampedSpeed).toFixed(4);
    speedFilter = `setpts=${setptsValue}*PTS,`;
  }

  // Dithering & color optimization based on quality
  let dither = "bayer";
  if (quality === "high") dither = "floyd_steinberg";
  if (quality === "low") dither = "bayer"; // Keep bayer even for low quality

  // Use balanced scaling algorithms - better quality with reasonable speed
  // bilinear is good balance, lanczos is best quality
  const scaleFlags = quality === "low" ? "flags=bilinear" : "flags=lanczos";

  // Generate temporary palette
  const palettePath = `palette_${Date.now()}.png`;

  // Set loop value: 0 = infinite loop, -1 = no loop (plays once)
  const loopValue = loop ? "0" : "-1";


  // Step 1: Generate color palette (balanced for quality and speed)
  // Use stats_mode=diff for better quality (analyzes frame differences)
  // Use full 256 colors for all quality levels for better color accuracy
  const paletteSize = "256"; // Full palette for all quality levels
  const statsMode = quality === "low" ? "single" : "diff"; // Use diff for medium/high quality
  const paletteFilter = speedFilter 
    ? `${speedFilter}fps=${fps},scale=${scale}:${scaleFlags},palettegen=stats_mode=${statsMode}:max_colors=${paletteSize}`
    : `fps=${fps},scale=${scale}:${scaleFlags},palettegen=stats_mode=${statsMode}:max_colors=${paletteSize}`;
  
  // Create ffmpeg instance for palette generation
  const paletteFfmpeg = ffmpeg(inputPath);
  
  // Add trim options if startTime > 0 or endTime < video duration
  if (startTime > 0) {
    paletteFfmpeg.seekInput(startTime);
  }
  if (duration > 0 && duration < 600) {
    paletteFfmpeg.duration(duration);
  }
  
  // Optimize for speed
  paletteFfmpeg
    .outputOptions([
      "-vf", paletteFilter,
      "-threads", "0"  // Auto-detect optimal thread count
    ])
    .on("end", () => {
      // Step 2: Use palette for better color accuracy
      const conversionFilter = speedFilter
        ? `[0:v]${speedFilter}fps=${fps},scale=${scale}:${scaleFlags}[x];[x][1:v]paletteuse=dither=${dither}`
        : `[0:v]fps=${fps},scale=${scale}:${scaleFlags}[x];[x][1:v]paletteuse=dither=${dither}`;
      
      // Create ffmpeg instance for conversion
      const convertFfmpeg = ffmpeg(inputPath);
      
      // Add trim options for conversion
      if (startTime > 0) {
        convertFfmpeg.seekInput(startTime);
      }
      if (duration > 0 && duration < 600) {
        convertFfmpeg.duration(duration);
      }
      
      // Optimize for speed
      convertFfmpeg
        .input(palettePath)
        .complexFilter(conversionFilter)
        .outputOptions([
          "-loop", loopValue,
          "-threads", "0"  // Auto-detect optimal thread count
        ])
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

  // Clean up temp files
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

app.listen(10000, () => console.log("🚀 Server running on port 10000"));
