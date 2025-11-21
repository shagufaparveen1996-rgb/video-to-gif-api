import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.ES_API_KEY;

// -------------------------
//  API KEY MIDDLEWARE
// -------------------------
function checkAPIKey(req, res, next) {
    const key = req.headers["x-api-key"];
    if (!key) {
        return res.status(401).json({ error: "API key missing" });
    }
    if (key !== API_KEY) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

// -------------------------
// Multer storage (temp uploads)
// -------------------------
const upload = multer({ 
    dest: "uploads/",
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    }
});

// Ensure uploads directory exists
if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads", { recursive: true });
}

// -------------------------
// Convert Route
// -------------------------
app.post("/convert", checkAPIKey, upload.single("video"), async (req, res) => {
    let inputPath = null;
    let outputPath = null;
    let palettePath = null;

    try {
        if (!req.file) {
            return res.status(400).json({ error: "No video uploaded" });
        }

        inputPath = req.file.path;
        outputPath = `output_${Date.now()}.gif`;

        // Convert all parameters to proper types
        const fpsNum = parseFloat(req.body.fps) || 10;
        const quality = req.body.quality || "medium";
        const sizeNum = parseInt(req.body.size) || 480;
        const speedNum = parseFloat(req.body.speed) || 1.0;
        const startNum = parseFloat(req.body.startTime) || 0;
        const endNum = parseFloat(req.body.endTime) || 60;
        const loopNum = parseInt(req.body.loop) || 0; // 0 = infinite loop, 1 = play once

        // Validate parameters
        if (fpsNum < 5 || fpsNum > 30) {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            return res.status(400).json({ error: "FPS must be between 5 and 30" });
        }

        if (sizeNum < 200 || sizeNum > 800) {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            return res.status(400).json({ error: "Size must be between 200 and 800" });
        }

        const duration = Math.max(0.1, endNum - startNum);
        if (duration > 60) {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            return res.status(400).json({ error: "Video duration cannot exceed 60 seconds" });
        }

        // QUALITY PRESETS for GIF - Optimized for speed
        let paletteColors = 128; // Default for medium
        let dither = "bayer"; // Dithering algorithm
        let statsMode = "diff"; // Faster palette generation (changed from "full")
        let scaleFlags = "fast_bilinear"; // Faster scaling (changed from "lanczos")
        
        if (quality === "low") {
            paletteColors = 64; // 64 colors = smaller file, lower quality
            dither = "none"; // No dithering for faster processing
            statsMode = "diff"; // Fastest palette generation
            scaleFlags = "fast_bilinear"; // Fastest scaling
        } else if (quality === "high") {
            paletteColors = 256; // 256 colors = full color palette, best quality
            dither = "bayer:bayer_scale=5"; // Better dithering for high quality
            statsMode = "full"; // Best quality palette generation
            scaleFlags = "lanczos"; // Best quality scaling
        } else {
            // medium (default) - Balanced speed and quality
            paletteColors = 128; // 128 colors = balanced quality
            dither = "bayer"; // Standard dithering
            statsMode = "diff"; // Faster palette generation
            scaleFlags = "bilinear"; // Balanced scaling speed
        }

        console.log("Conversion started:", {
            fps: fpsNum,
            quality: quality,
            paletteColors: paletteColors,
            size: sizeNum,
            speed: speedNum,
            start: startNum,
            end: endNum,
            duration: duration,
            loop: loopNum
        });

        // Create palette file path
        palettePath = `palette_${Date.now()}.png`;

        // Step 1: Generate palette from video - ULTRA FAST mode
        try {
            await new Promise((resolve, reject) => {
                // For faster processing, sample fewer frames for palette
                const sampleRate = quality === "low" ? 3 : quality === "medium" ? 2 : 1; // Sample every Nth frame
                const sampledFps = Math.max(2, fpsNum / sampleRate); // Minimum 2 fps for palette
                
                ffmpeg(inputPath)
                    .inputOptions([`-ss ${startNum}`]) // Seek before input (faster for MP4)
                    .inputOptions([`-t ${Math.min(duration, 10)}`]) // Limit to 10s max for palette (faster)
                    .inputOptions(["-threads", "0"]) // Use all available CPU threads
                    .inputOptions(["-vsync", "0"]) // Disable frame sync for speed
                    .inputOptions(["-an"]) // Skip audio (not needed for palette)
                    .inputOptions(["-sn"]) // Skip subtitles
                    .videoFilters([
                        `fps=${sampledFps}`, // Sample fewer frames for palette
                        `scale=${sizeNum}:-1:flags=${scaleFlags}`, // Faster scaling
                        `setpts=${1 / speedNum}*PTS`,
                        `palettegen=max_colors=${paletteColors}:reserve_transparent=0:stats_mode=${statsMode}` // Faster stats mode
                    ])
                    .outputOptions(["-y"])
                    .outputOptions(["-threads", "0"]) // Use all threads for output
                    .output(palettePath)
                    .on("end", () => {
                        console.log("Palette generated successfully");
                        resolve();
                    })
                    .on("error", (err) => {
                        console.error("Palette generation error:", err);
                        reject(err);
                    })
                    .run();
            });
        } catch (paletteError) {
            console.error("Failed to generate palette:", paletteError);
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(palettePath)) fs.unlinkSync(palettePath);
            return res.status(500).json({ 
                error: "Failed to generate color palette", 
                details: paletteError.message 
            });
        }

        // Step 2: Create GIF using palette with filter_complex - ULTRA FAST mode
        const filterComplex = `[0:v]fps=${fpsNum},scale=${sizeNum}:-1:flags=${scaleFlags},setpts=${1 / speedNum}*PTS[v];[v][1:v]paletteuse=dither=${dither}`;
        
        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(inputPath)
                .inputOptions([`-ss ${startNum}`]) // Seek before input (faster for MP4)
                .inputOptions([`-t ${duration}`]) // Duration limit
                .inputOptions(["-threads", "0"]) // Use all available CPU threads
                .inputOptions(["-vsync", "0"]) // Disable frame sync for speed
                .inputOptions(["-an"]) // Skip audio (not needed for GIF)
                .inputOptions(["-sn"]) // Skip subtitles
                .input(palettePath)
                .complexFilter(filterComplex)
                .outputOptions([`-loop ${loopNum}`]) // 0 = infinite, 1 = once, 2 = twice, etc.
                .outputOptions(["-y"]) // Overwrite output file
                .outputOptions(["-threads", "0"]) // Use all threads for output
                .outputOptions(["-gifflags", "+transdiff"]) // Optimize GIF encoding
                .output(outputPath)
                .on("start", (commandLine) => {
                    console.log("FFmpeg command:", commandLine);
                })
                .on("progress", (progress) => {
                    if (progress.percent) {
                        console.log("Processing: " + Math.floor(progress.percent) + "% done");
                    }
                })
                .on("end", () => {
                    console.log("GIF conversion completed");
                    resolve();
                })
                .on("error", (err) => {
                    console.error("FFmpeg error:", err);
                    reject(err);
                })
                .run();
        });

        // Read and send the GIF
        if (!fs.existsSync(outputPath)) {
            throw new Error("Output file was not created");
        }

        const gifBuffer = fs.readFileSync(outputPath);
        const fileSize = gifBuffer.length;

        console.log("Conversion successful. File size:", fileSize, "bytes");

        // Return GIF as binary
        res.setHeader("Content-Type", "image/gif");
        res.setHeader("Content-Length", fileSize);
        res.send(gifBuffer);

        // Cleanup
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (fs.existsSync(palettePath)) fs.unlinkSync(palettePath);

    } catch (err) {
        console.error("Server error:", err);
        // Cleanup on error
        if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (palettePath && fs.existsSync(palettePath)) fs.unlinkSync(palettePath);
        return res.status(500).json({ 
            error: "Conversion failed", 
            details: err.message 
        });
    }
});

// -------------------------
// TEST ROUTE
// -------------------------
app.get("/", (req, res) => {
    res.json({ 
        status: "Video to GIF API running",
        version: "1.0.0"
    });
});

// -------------------------
// Health Check Route
// -------------------------
app.get("/health", (req, res) => {
    res.json({ 
        status: "healthy",
        timestamp: new Date().toISOString()
    });
});

// -------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});
