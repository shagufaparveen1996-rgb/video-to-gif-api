import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

// Get __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
// Note: Don't use json/urlencoded with multer - multer handles multipart/form-data automatically
// Text fields from multipart/form-data will be in req.body

const API_KEY = process.env.ES_API_KEY || 'bd79c0f2054094a74c6d25257ee7ef95';

// Ensure uploads directory exists
const uploadsDir = "uploads";
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log("📁 Created uploads directory");
}

// API Key protection
app.use((req, res, next) => {
  const key = req.headers["x-api-key"];
  console.log("🔑 API Key check - Received:", key ? "Present" : "Missing", "Expected:", API_KEY ? "Set" : "Not Set");
  if (!key || key !== API_KEY) {
    console.error("❌ Unauthorized request - Key mismatch or missing");
    return res.status(403).json({ error: "Unauthorized - Invalid or missing API key" });
  }
  next();
});

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  preservePath: true // Important: ensures text fields are parsed correctly
});

// Handle multer errors
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    console.error("❌ Multer error:", error.message);
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: "File size exceeds 50MB limit. Please choose a smaller video file." });
    }
    return res.status(400).json({ error: "File upload error: " + error.message });
  }
  next(error);
});


// API endpoint: Convert video → high-quality, dynamic GIF
app.post("/convert", upload.single("video"), (req, res) => {
  // Add error handler to prevent crashes
  try {
    console.log("📨 POST /convert received");
    console.log("📋 Headers:", {
      contentType: req.headers["content-type"],
      contentLength: req.headers["content-length"],
      hasFile: !!req.file
    });
    
    if (!req.file) {
      console.error("❌ No file in request");
      console.error("📋 Request body keys:", Object.keys(req.body || {}));
      console.error("📋 Files:", Object.keys(req.files || {}));
      return res.status(400).json({ error: "No video file uploaded. Please ensure the file field is named 'video'." });
    }

  const inputPath = req.file.path;
    
    // Check if input file exists
    if (!fs.existsSync(inputPath)) {
      console.error("❌ File not found at path:", inputPath);
      console.error("📁 File object:", req.file);
      return res.status(400).json({ error: "Uploaded file not found. Path: " + inputPath });
    }
    
    // Check file size
    const fileStats = fs.statSync(inputPath);
    console.log("📊 File stats:", { size: fileStats.size, path: inputPath });
    
    if (fileStats.size === 0) {
      console.error("❌ File is empty");
      return res.status(400).json({ error: "Uploaded file is empty. Please upload a valid video file." });
    }
    
  // Use absolute paths for output files
  const outputFile = path.join(__dirname, `output_${Date.now()}.gif`);
    const palettePath = path.join(__dirname, `palette_${Date.now()}.png`);
    
    console.log("📁 Output paths:", { outputFile, palettePath });

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

    // Debug: Log received data
    console.log("📥 Received request body:", JSON.stringify(req.body, null, 2));
    console.log("📁 File info:", req.file ? { name: req.file.originalname, size: req.file.size, path: req.file.path } : "No file");
    
    // Dynamic values from frontend (or defaults) - ensure we parse them correctly
    // Multer parses text fields as strings, so we need to convert them
    let fps = req.body.fps ? parseInt(String(req.body.fps)) : 10;
    let quality = (req.body.quality && ['low', 'medium', 'high'].includes(String(req.body.quality))) 
      ? String(req.body.quality) 
      : "medium";
    let size = req.body.size ? String(req.body.size) : "480";
    let speed = req.body.speed ? parseFloat(String(req.body.speed)) : 1.0;
    let startTime = req.body.startTime ? parseFloat(String(req.body.startTime)) : 0;
    let endTime = req.body.endTime ? parseFloat(String(req.body.endTime)) : 60;
    
    console.log("⚙️ Raw settings from request:", {
      fps: req.body.fps,
      quality: req.body.quality,
      size: req.body.size,
      speed: req.body.speed,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      loop: req.body.loop
    });
    
    console.log("⚙️ Parsed settings:", { fps, quality, size, speed, startTime, endTime });
    
    // Validate parsed values - ensure minimum 5 FPS, cap at 20 for faster conversion
    if (isNaN(fps) || fps < 5 || fps > 20) {
      console.warn("⚠️ Invalid FPS, using default 10");
      fps = 10;
    }
    // Ensure minimum 5 FPS for stable conversion
    fps = Math.max(5, Math.min(fps, 20));
    
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
    // Validate endTime - ensure it's greater than startTime
    if (isNaN(endTime) || endTime <= startTime) {
      console.warn("⚠️ Invalid endTime:", endTime, "startTime:", startTime, "using startTime + 1");
      endTime = startTime + 1.0;
    }
    
    // Ensure minimum 1 second duration
    if (endTime - startTime < 1.0) {
      console.warn("⚠️ Duration too short, adjusting endTime");
      endTime = startTime + 1.0;
    }
  
  // Parse loop parameter - handle string '1'/'0', number 1/0, or boolean
  let loop = true; // Default to true
  if (req.body.loop !== undefined && req.body.loop !== null) {
    const loopValueFromBody = req.body.loop;
    if (loopValueFromBody === '0' || loopValueFromBody === 0 || loopValueFromBody === false || loopValueFromBody === 'false') {
      loop = false;
    } else if (loopValueFromBody === '1' || loopValueFromBody === 1 || loopValueFromBody === true || loopValueFromBody === 'true') {
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

  // Set loop value: 0 = infinite loop, -1 = no loop (plays once)
  const loopValue = loop ? "0" : "-1";

    // Step 1: Generate color palette (optimized for speed)
    // Use stats_mode=single for all quality levels - much faster than diff
    // Reduce palette colors for faster processing
    const paletteSize = quality === "low" ? "128" : quality === "medium" ? "192" : "256";
    const statsMode = "single"; // Always use single for speed (diff is 2-3x slower)
    
    // Ensure FPS is valid for palette generation (already validated above, but ensure here too)
    const validFPS = Math.max(5, Math.min(fps, 20));
    
    // Get actual video duration first to prevent errors
    console.log("🔍 Starting ffprobe for:", inputPath);
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        console.error("❌ Error getting video metadata:", err.message);
        console.error("❌ Error stack:", err.stack);
        if (!res.headersSent) {
          return res.status(400).json({ error: "Could not read video file. Please ensure it's a valid video file. Error: " + err.message });
        }
        return cleanup();
      }

      if (!metadata || !metadata.format) {
        console.error("❌ Invalid metadata received:", metadata);
        if (!res.headersSent) {
          return res.status(400).json({ error: "Could not read video metadata. Invalid video file." });
        }
        return cleanup();
      }

      // Get duration - try format first, then streams
      let actualDuration = 0;
      
      // Try format duration
      if (metadata.format && metadata.format.duration) {
        const formatDur = parseFloat(metadata.format.duration);
        if (!isNaN(formatDur) && isFinite(formatDur) && formatDur > 0) {
          actualDuration = formatDur;
        }
      }
      
      // If format duration not available, try video stream
      if (actualDuration === 0 && metadata.streams) {
        for (const stream of metadata.streams) {
          if (stream.codec_type === 'video' && stream.duration) {
            const streamDur = parseFloat(stream.duration);
            if (!isNaN(streamDur) && isFinite(streamDur) && streamDur > 0) {
              actualDuration = streamDur;
              break;
            }
          }
        }
      }
      
      console.log("📹 Video duration:", actualDuration, "seconds");
      
      // Validate duration
      if (!actualDuration || actualDuration < 1.0) {
        console.error("❌ Invalid or missing video duration");
        if (!res.headersSent) {
          return res.status(400).json({ error: "Could not determine video duration. Please ensure the video file is valid." });
        }
        return cleanup();
      }
      
      // Limit to 60 seconds max
      const maxAvailableDuration = Math.min(actualDuration, 60);
      
      // Simple validation and clamping
      let finalStartTime = Math.max(0, Math.min(startTime || 0, maxAvailableDuration - 1.0));
      let finalEndTime = Math.min(endTime || maxAvailableDuration, maxAvailableDuration);
      
      // Ensure endTime > startTime and minimum 1 second
      if (finalEndTime <= finalStartTime) {
        finalEndTime = Math.min(finalStartTime + 1.0, maxAvailableDuration);
      }
      
      let finalDuration = finalEndTime - finalStartTime;
      
      // Ensure minimum 1 second duration
      if (finalDuration < 1.0) {
        finalEndTime = Math.min(finalStartTime + 1.0, maxAvailableDuration);
        finalDuration = 1.0;
      }
      
      // Final validation
      if (finalDuration < 1.0 || finalEndTime <= finalStartTime) {
        console.error("❌ Invalid time range");
        if (!res.headersSent) {
          return res.status(400).json({ error: `Invalid time range. Video duration: ${actualDuration.toFixed(2)}s.` });
        }
        return cleanup();
      }

      console.log("✅ Processing:", finalStartTime, "to", finalEndTime, "duration:", finalDuration, "FPS:", validFPS);

      const paletteFilter = speedFilter 
        ? `${speedFilter}fps=${validFPS},scale=${scale}:${scaleFlags},palettegen=stats_mode=${statsMode}:max_colors=${paletteSize}`
        : `fps=${validFPS},scale=${scale}:${scaleFlags},palettegen=stats_mode=${statsMode}:max_colors=${paletteSize}`;

      // Create ffmpeg instance for palette generation
      const paletteFfmpeg = ffmpeg(inputPath);
      
      // Add trim options for palette generation
      // Ensure values are valid numbers before passing to FFmpeg
      const safeStartTime = isNaN(finalStartTime) || !isFinite(finalStartTime) ? 0 : Math.max(0, finalStartTime);
      const safeDuration = isNaN(finalDuration) || !isFinite(finalDuration) || finalDuration < 1.0 ? 1.0 : finalDuration;
      
      console.log("🔧 FFmpeg parameters:", { safeStartTime, safeDuration, original: { finalStartTime, finalDuration } });
      
      if (safeStartTime > 0) {
        paletteFfmpeg.seekInput(safeStartTime);
      }
      paletteFfmpeg.duration(safeDuration);
      
      // Optimize for speed - palettegen outputs PNG automatically
      console.log("🎨 Starting palette generation with filter:", paletteFilter);
      paletteFfmpeg
        .outputOptions([
          "-vf", paletteFilter,
          "-threads", "0"  // Auto-detect optimal thread count
        ])
        .on("start", (cmd) => {
          console.log("▶️ FFmpeg command:", cmd);
        })
        .on("progress", (progress) => {
          if (progress && progress.percent !== undefined) {
            console.log("📊 Palette progress:", progress.percent + "%");
          }
        })
        .on("end", () => {
          console.log("✅ Palette generation completed");
          
          // Check if palette file exists
          if (!fs.existsSync(palettePath)) {
            console.error("❌ Palette file not found:", palettePath);
            if (!res.headersSent) {
              return res.status(500).json({ error: "Palette generation completed but palette file not found." });
            }
            return cleanup();
          }
          
          console.log("✅ Palette file exists:", palettePath);
          
          // Step 2: Use palette for better color accuracy
          // Use validated FPS
          const conversionFilter = speedFilter
            ? `[0:v]${speedFilter}fps=${validFPS},scale=${scale}:${scaleFlags}[x];[x][1:v]paletteuse=dither=${dither}`
            : `[0:v]fps=${validFPS},scale=${scale}:${scaleFlags}[x];[x][1:v]paletteuse=dither=${dither}`;
          
          // Create ffmpeg instance for conversion
          const convertFfmpeg = ffmpeg(inputPath);
          
          // Add trim options for conversion - use same safe values as palette
          const safeStartTime = isNaN(finalStartTime) || !isFinite(finalStartTime) ? 0 : Math.max(0, finalStartTime);
          const safeDuration = isNaN(finalDuration) || !isFinite(finalDuration) || finalDuration < 1.0 ? 1.0 : finalDuration;
          
          if (safeStartTime > 0) {
            convertFfmpeg.seekInput(safeStartTime);
          }
          convertFfmpeg.duration(safeDuration);
          
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
              if (!res.headersSent) {
                res.status(500).json({ error: "Video conversion failed: " + err.message });
              }
              cleanup();
            })
            .on("end", () => {
              if (!res.headersSent) {
                // Check if output file exists
                if (!fs.existsSync(outputFile)) {
                  console.error("❌ Output file not found:", outputFile);
                  return res.status(500).json({ error: "Conversion completed but output file not found." });
                }
                
                // Send GIF file with proper headers
                console.log("📤 Sending GIF file:", outputFile);
                console.log("📊 File size:", fs.statSync(outputFile).size, "bytes");
                
                // Set headers before streaming
                if (!res.headersSent) {
                  res.setHeader('Content-Type', 'image/gif');
                  res.setHeader('Content-Disposition', `attachment; filename="converted_${Date.now()}.gif"`);
                  res.setHeader('Content-Length', fs.statSync(outputFile).size);
                }
                
                const fileStream = fs.createReadStream(outputFile);
                fileStream.pipe(res);
                fileStream.on('end', () => {
                  console.log("✅ GIF file sent successfully");
                  cleanup();
                });
                fileStream.on('error', (err) => {
                  console.error("❌ Error streaming file:", err);
                  if (!res.headersSent) {
                    res.status(500).json({ error: "Error sending converted file." });
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
          if (err.stderr) {
            console.error("❌ FFmpeg stderr:", err.stderr);
          }
          if (!res.headersSent) {
            res.status(500).json({ error: "Palette generation failed: " + err.message });
          }
      cleanup();
    })
    .save(palettePath);
    });
  } catch (error) {
    console.error("❌ Server error:", error.message);
    console.error("❌ Error stack:", error.stack);
    console.error("❌ Error details:", {
      name: error.name,
      message: error.message,
      code: error.code,
      errno: error.errno,
      syscall: error.syscall
    });
    if (!res.headersSent) {
      // Send detailed error message for debugging
      const errorMessage = process.env.NODE_ENV === 'development' 
        ? `Server error: ${error.message} (${error.name})`
        : `Server error: ${error.message}`;
      res.status(500).json({ error: errorMessage });
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
