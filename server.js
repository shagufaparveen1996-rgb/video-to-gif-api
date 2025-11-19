import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  // Add error handler to prevent crashes
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No video file uploaded." });
    }

    const inputPath = req.file.path;
    const outputFile = path.join(__dirname, `output_${Date.now()}.gif`);
    
    // Validate input file exists
    if (!fs.existsSync(inputPath)) {
      console.error("❌ Input file not found:", inputPath);
      return res.status(400).json({ error: "Uploaded file not found" });
    }
    
    console.log("📥 Processing video:", {
      inputPath,
      outputFile,
      fileSize: fs.statSync(inputPath).size
    });

    // Dynamic values from frontend (or defaults) - ensure we parse them correctly
    // Multer parses text fields as strings, so we need to convert them
    // Lower default FPS for faster conversion
    let fps = req.body.fps ? parseInt(String(req.body.fps)) : 10;
    let quality = (req.body.quality && ['low', 'medium', 'high'].includes(String(req.body.quality))) 
      ? String(req.body.quality) 
      : "medium";
    let size = req.body.size ? String(req.body.size) : "480";
    let speed = req.body.speed ? parseFloat(String(req.body.speed)) : 1.0;
    let startTime = req.body.startTime ? parseFloat(String(req.body.startTime)) : 0;
    let endTime = req.body.endTime ? parseFloat(String(req.body.endTime)) : 60;
    
    // Validate parsed values - cap FPS at 20 for faster conversion
    if (isNaN(fps) || fps < 0 || fps > 20) {
      console.warn("⚠️ Invalid FPS, using default 10");
      fps = 10;
    }
    
    // Validate and parse size
    let sizeNum = parseInt(size) || 480;
    if (isNaN(sizeNum) || sizeNum < 100 || sizeNum > 800) {
      console.warn("⚠️ Invalid size:", size, "using default 480");
      sizeNum = 480;
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
    
    // Calculate duration and ensure minimum 0.5 seconds for stable conversion
    let duration = endTime - startTime;
    if (duration < 0.5) {
      console.warn("⚠️ Duration too short:", duration, "adjusting to minimum 0.5 seconds");
      duration = 0.5;
      endTime = startTime + 0.5;
    }
    duration = Math.max(0.5, Math.min(duration, 600));
    
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

    // Use faster scaling algorithms for speed
    // fast_bilinear is fastest, bilinear is faster, lanczos is best but slowest
    const scaleFlags = quality === "low" ? "flags=fast_bilinear" : quality === "medium" ? "flags=bilinear" : "flags=lanczos";

    // Generate temporary palette - use absolute path
    const palettePath = path.join(__dirname, `palette_${Date.now()}.png`);

    // Set loop value: 0 = infinite loop, -1 = no loop (plays once)
    const loopValue = loop ? "0" : "-1";


    // Step 1: Generate color palette (optimized for speed)
    // Use stats_mode=single for all quality levels - much faster than diff
    // Reduce palette colors for faster processing
    const paletteSize = quality === "low" ? "128" : quality === "medium" ? "192" : "256";
    const statsMode = "single"; // Always use single for speed (diff is 2-3x slower)
    
    const paletteFilter = speedFilter 
      ? `${speedFilter}fps=${fps},scale=${scale}:${scaleFlags},palettegen=stats_mode=${statsMode}:max_colors=${paletteSize}`
      : `fps=${fps},scale=${scale}:${scaleFlags},palettegen=stats_mode=${statsMode}:max_colors=${paletteSize}`;
    
    // Create ffmpeg instance for palette generation
    const paletteFfmpeg = ffmpeg(inputPath);
    
    // Use validated duration (already validated above)
    const validDuration = duration;
    
    // Add trim options if startTime > 0 or endTime < video duration
    if (startTime > 0) {
      paletteFfmpeg.seekInput(startTime);
    }
    if (validDuration > 0 && validDuration < 600) {
      paletteFfmpeg.duration(validDuration);
    }
    
    // Optimize for speed - palettegen outputs PNG automatically
    paletteFfmpeg
      .outputOptions([
        "-vf", paletteFilter,
        "-threads", "0"  // Auto-detect optimal thread count
      ])
      .on("start", (cmd) => {
        console.log("🎨 Starting palette generation...");
        console.log("📋 FFmpeg command:", cmd);
      })
      .on("progress", (progress) => {
        console.log("📊 Palette progress:", progress.percent + "%");
      })
      .on("end", () => {
        console.log("✅ Palette generation completed");
        
        // Check if palette file was created
        if (!fs.existsSync(palettePath)) {
          console.error("❌ Palette file not created:", palettePath);
          if (!res.headersSent) {
            return res.status(500).json({ error: "Palette generation failed - file not created" });
          }
          return cleanup();
        }
        
        // Step 2: Use palette for better color accuracy
        const conversionFilter = speedFilter
          ? `[0:v]${speedFilter}fps=${fps},scale=${scale}:${scaleFlags}[x];[x][1:v]paletteuse=dither=${dither}`
          : `[0:v]fps=${fps},scale=${scale}:${scaleFlags}[x];[x][1:v]paletteuse=dither=${dither}`;
        
        // Create ffmpeg instance for conversion
        const convertFfmpeg = ffmpeg(inputPath);
        
        // Add trim options for conversion - use validated duration
        if (startTime > 0) {
          convertFfmpeg.seekInput(startTime);
        }
        if (validDuration > 0 && validDuration < 600) {
          convertFfmpeg.duration(validDuration);
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
          .on("start", (cmd) => {
            console.log("🎬 Starting GIF conversion...");
            console.log("📋 FFmpeg command:", cmd);
          })
          .on("progress", (progress) => {
            console.log("📊 Conversion progress:", progress.percent + "%");
          })
          .on("error", (err) => {
            console.error("❌ FFmpeg error:", err.message);
            console.error("❌ Error details:", err);
            if (!res.headersSent) {
              res.status(500).json({ 
                error: "Video conversion failed", 
                message: err.message,
                details: process.env.NODE_ENV === 'development' ? err.stack : undefined
              });
            }
            cleanup();
          })
          .on("end", () => {
            // Check if output file was created
            if (!fs.existsSync(outputFile)) {
              console.error("❌ Output GIF file not created:", outputFile);
              if (!res.headersSent) {
                return res.status(500).json({ error: "GIF conversion failed - file not created" });
              }
              return cleanup();
            }
            
            console.log("✅ GIF conversion completed:", outputFile);
            
            if (!res.headersSent) {
              res.download(outputFile, (err) => {
                if (err) {
                  console.error("❌ Download error:", err.message);
                  if (!res.headersSent) {
                    res.status(500).json({ error: "Failed to send GIF file" });
                  }
                }
                cleanup();
              });
            } else {
              cleanup();
            }
          })
          .save(outputFile);
      })
      .on("error", (err) => {
        console.error("❌ Palette generation error:", err.message);
        console.error("❌ Error details:", err);
        if (!res.headersSent) {
          res.status(500).json({ 
            error: "Palette generation failed", 
            message: err.message,
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
          });
        }
        cleanup();
      })
      .save(palettePath);

    // Clean up temp files
    function cleanup() {
      try {
        [inputPath, outputFile, palettePath].forEach((file) => {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
        });
      } catch (cleanupErr) {
        console.error("❌ Cleanup error:", cleanupErr.message);
      }
    }
  } catch (error) {
    console.error("❌ Server error:", error.message);
    console.error("❌ Error stack:", error.stack);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: "Server error", 
        message: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
});

// Test route
app.get("/", (req, res) => {
  res.send("✅ Video to GIF API running successfully — use /convert endpoint");
});

// Global error handler to prevent crashes
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(10000, () => console.log("🚀 Server running on port 10000"));
