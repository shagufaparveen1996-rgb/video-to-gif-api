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
const upload = multer({ dest: "uploads/" });

// -------------------------
// Convert Route
// -------------------------
app.post("/convert", checkAPIKey, upload.single("video"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No video uploaded" });
        }

        const {
            fps = 15,
            quality = "medium",
            size = 480,
            speed = 1.0,
            startTime = 0,
            endTime = 60,
            loop = 1
        } = req.body;

        const inputPath = req.file.path;
        const outputPath = `output_${Date.now()}.gif`;

        // QUALITY PRESETS
        let qscale = 20; // medium
        if (quality === "low") qscale = 30;
        if (quality === "high") qscale = 10;

        // FFmpeg processing
        ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(endTime - startTime)
            .videoFilters([
                `fps=${fps}`,
                `scale=${size}:-1`,
                `setpts=${1 / speed}*PTS`
            ])
            .outputOptions([`-loop ${loop}`])
            .outputOptions([`-qscale ${qscale}`])
            .output(outputPath)
            .on("end", () => {
                const gifBuffer = fs.readFileSync(outputPath);

                // Return GIF as base64
                res.setHeader("Content-Type", "image/gif");
                res.send(gifBuffer);

                // Cleanup
                fs.unlinkSync(inputPath);
                fs.unlinkSync(outputPath);
            })
            .on("error", (err) => {
                console.error(err);
                fs.unlinkSync(inputPath);
                return res.status(500).json({ error: "Conversion failed", details: err.message });
            })
            .run();

    } catch (err) {
        return res.status(500).json({ error: "Server error", details: err.message });
    }
});

// -------------------------
// TEST ROUTE
// -------------------------
app.get("/", (req, res) => {
    res.json({ status: "Video to GIF API running" });
});

// -------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API running on", PORT));
