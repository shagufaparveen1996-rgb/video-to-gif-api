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

        // QUALITY PRESETS
        let qscale = 20; // medium (default)
        if (quality === "low") qscale = 30;
        else if (quality === "high") qscale = 10;

        console.log("Conversion started:", {
            fps: fpsNum,
            quality: quality,
            size: sizeNum,
            speed: speedNum,
            start: startNum,
            end: endNum,
            duration: duration,
            loop: loopNum
        });

        // FFmpeg processing
        ffmpeg(inputPath)
            .setStartTime(startNum)
            .setDuration(duration)
            .videoFilters([
                `fps=${fpsNum}`,
                `scale=${sizeNum}:-1`,
                `setpts=${1 / speedNum}*PTS`
            ])
            .outputOptions([`-loop ${loopNum}`]) // 0 = infinite, 1 = once, 2 = twice, etc.
            .outputOptions([`-qscale ${qscale}`])
            .outputOptions(["-y"]) // Overwrite output file
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
                try {
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
                } catch (err) {
                    console.error("Error sending response:", err);
                    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    return res.status(500).json({ error: "Failed to read output file", details: err.message });
                }
            })
            .on("error", (err) => {
                console.error("FFmpeg error:", err);
                // Cleanup on error
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                return res.status(500).json({ 
                    error: "Conversion failed", 
                    details: err.message 
                });
            })
            .run();

    } catch (err) {
        console.error("Server error:", err);
        // Cleanup on error
        if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        return res.status(500).json({ 
            error: "Server error", 
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

