import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.ES_API_KEY;

// API Key protection
app.use((req, res, next) => {
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
});

const upload = multer({ dest: "uploads/" });

// API endpoint: Convert video → high-quality GIF
app.post("/convert", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).send("No video file uploaded.");

  const inputPath = req.file.path;
  const outputFile = `output_${Date.now()}.gif`;

  // FFmpeg settings: sharp, smooth & looped GIF
  ffmpeg(inputPath)
    .outputOptions([
      "-vf", "fps=15,scale=480:-1:flags=lanczos", // smooth & detailed
      "-loop", "0" // infinite loop
    ])
    .toFormat("gif")
    .on("start", (cmd) => console.log("FFmpeg command:", cmd))
    .on("error", (err) => {
      console.error("FFmpeg error:", err.message);
      res.status(500).send("Video conversion failed");
      fs.unlinkSync(inputPath);
    })
    .on("end", () => {
      console.log("✅ Conversion done:", outputFile);
      res.download(outputFile, () => {
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputFile);
      });
    })
    .save(outputFile);
});

// Test route
app.get("/", (req, res) => {
  res.send("✅ Video to GIF API running successfully — use /convert endpoint");
});

app.listen(10000, () => console.log("🚀 Server running on port 10000"));
