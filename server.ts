import express from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize Gemini client securely
const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({
  apiKey: apiKey,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// Database path for storing translation history
const DB_PATH = path.join(process.cwd(), "history_db.json");

// Helper to read history from database
function readHistory(): any[] {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
      return [];
    }
    const data = fs.readFileSync(DB_PATH, "utf-8");
    return JSON.parse(data || "[]");
  } catch (error) {
    console.error("Error reading history database:", error);
    return [];
  }
}

// Helper to write history to database
function writeHistory(history: any[]) {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DB_PATH, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error("Error writing to history database:", error);
  }
}

// 1. API: Translation Endpoint
app.post("/api/translate", async (req, res) => {
  const { text, sourceLang, targetLang, tone, context } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Input text is required" });
  }

  try {
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not configured");
    }

    const sourceLangText = sourceLang === "auto" ? "any detected language" : sourceLang;
    const toneText = tone ? `Tone: '${tone}'` : "Tone: Natural/Contextual";
    const contextText = context ? `Cultural or situational context info: '${context}'` : "None";

    const prompt = `You are a professional linguistic translator and cultural expert.
Translate the following input text into the target language.

Input Text: "${text}"
Target Language: "${targetLang}"
Specified Source Language: "${sourceLangText}"
Requested Tone/Style: "${toneText}"
Additional Situational/Cultural Context: "${contextText}"

Instructions:
1. Detect the actual source language of the input.
2. Provide an extremely accurate translation into the native script of the target language (e.g., Urdu in Nastaliq/Arabic script, Japanese in Kanji/Hiragana/Katakana, Arabic in Arabic script). DO NOT transliterate the main translation into English letters (e.g., do not write "Aap kaise hain" for Urdu, write the actual literature script "آپ کیسے ہیں").
3. Make sure the translation is culturally sensitive and adheres perfectly to the requested tone (e.g. if the tone is polite/formal, "how are you" in Urdu should be "آپ کیسے ہیں" instead of casual forms).
4. Provide a pronunciation guide/romanization to help an English speaker pronounce the translated text. E.g., for "آپ کیسے ہیں", write "Aap kaise hain?".
5. Provide a brief cultural explanation or grammatical context about why this translation is chosen and how it fits the requested tone.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detectedLanguage: {
              type: Type.STRING,
              description: "The detected source language name (e.g. 'English', 'French')"
            },
            detectedLanguageCode: {
              type: Type.STRING,
              description: "The 2-letter ISO code of the detected language (e.g. 'en', 'fr')"
            },
            translation: {
              type: Type.STRING,
              description: "The translated text in the target language's native script/characters only."
            },
            pronunciation: {
              type: Type.STRING,
              description: "Phonetic pronunciation guide or Romanized transliteration (e.g., romaji for Japanese, pinyin for Chinese, romanized Urdu)."
            },
            explanation: {
              type: Type.STRING,
              description: "A short context note explaining tone choices, cultural nuances, or usage tips."
            }
          },
          required: ["detectedLanguage", "detectedLanguageCode", "translation", "pronunciation", "explanation"]
        }
      }
    });

    const resultText = response.text;
    if (!resultText) {
      throw new Error("Empty response received from Gemini API");
    }

    const translationData = JSON.parse(resultText);

    // Save record to persistent database
    const historyItem = {
      id: "hist_" + Math.random().toString(36).substr(2, 9),
      timestamp: new Date().toISOString(),
      inputText: text,
      sourceLang,
      targetLang,
      tone: tone || "Default",
      context: context || "",
      detectedLanguage: translationData.detectedLanguage,
      detectedLanguageCode: translationData.detectedLanguageCode,
      translation: translationData.translation,
      pronunciation: translationData.pronunciation,
      explanation: translationData.explanation,
    };

    const currentHistory = readHistory();
    currentHistory.unshift(historyItem); // Add to top
    writeHistory(currentHistory);

    res.json({
      success: true,
      data: historyItem
    });

  } catch (error: any) {
    console.error("Translation API Error:", error);
    res.status(500).json({
      error: "Failed to perform AI translation. Please try again.",
      details: error.message
    });
  }
});

// 2. API: Autocomplete Suggestions Endpoint
app.post("/api/autocomplete", async (req, res) => {
  const { text, targetLang } = req.body;

  if (!text || !text.trim() || text.length < 2) {
    return res.json({ suggestions: [] });
  }

  try {
    if (!apiKey) {
      return res.json({ suggestions: [] });
    }

    const prompt = `You are a real-time conversational helper. The user has typed the following starting fragment of a sentence: "${text}".
Predict 3 natural, highly common next phrases or full sentences that a user typing this would likely want to say.
Base these suggestions on common daily conversations, questions, or polite phrases (especially matching things like "how are you", "what are you doing", "how is life going", etc.).
Provide the suggestions in the language that the user is currently typing (which is usually English or the detected source language). Do not translate them yet.
Make the suggestions natural, concise, and direct continuations.
Return exactly 3 suggestions.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            suggestions: {
              type: Type.ARRAY,
              items: {
                type: Type.STRING
              },
              description: "Array of exactly 3 completing phrases or sentences continuing the input text."
            }
          },
          required: ["suggestions"]
        }
      }
    });

    const resultText = response.text;
    if (resultText) {
      const parsed = JSON.parse(resultText);
      res.json({ suggestions: parsed.suggestions || [] });
    } else {
      res.json({ suggestions: [] });
    }

  } catch (error) {
    console.error("Autocomplete API Error:", error);
    res.json({ suggestions: [] });
  }
});

// 3. API: History Management Endpoints
app.get("/api/history", (req, res) => {
  const history = readHistory();
  res.json({ success: true, data: history });
});

app.delete("/api/history", (req, res) => {
  writeHistory([]);
  res.json({ success: true, message: "History cleared successfully" });
});

app.delete("/api/history/:id", (req, res) => {
  const { id } = req.params;
  const history = readHistory();
  const filtered = history.filter((item) => item.id !== id);
  writeHistory(filtered);
  res.json({ success: true, message: "Item deleted successfully" });
});

// Integration with Vite
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
