import fs from "fs";
import path from "path";
import { resolveApiKey } from "./utils.js";

// ---------------------------------------------------------------------------
// TypeSafe/JEV API — noul query
// A Noul returns the probability (0–1) that a yes/no statement is true.
// This is the correct primitive for binary relevance checks, per the docs:
// "Use a Noul when the answer is yes or no."
// ---------------------------------------------------------------------------

interface NoulAnswer {
  type: "noul";
  noul: number; // 0.0 (no) to 1.0 (yes)
}

interface NoulResponse {
  answers: {
    is_relevant?: NoulAnswer;
  };
}

// Threshold: file is considered a match when relevance probability > 0.72
const NOUL_RELEVANCE_THRESHOLD = 0.72;

async function askJev(
  apiKey: string,
  query: string,
  fileContent: string
): Promise<number> {
  try {
    const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "typesafe/jev-1.13",
        // Structured state: separate content from the query per TypeSafe docs
        state: {
          file_content: fileContent.substring(0, 32000),
          search_query: query,
        },
        questions: {
          is_relevant: {
            type: "noul",
            instructions:
              "Does the file_content contain information that answers, matches, or is directly relevant to the search_query?",
            criteria: {
              true: "The file contains code, configuration, documentation, or data that directly relates to or answers the search_query.",
              false: "The file does not contain relevant information for the search_query, or the content is completely unrelated.",
            },
          },
        },
      }),
    });

    if (!response.ok) return 0;

    const data = (await response.json()) as NoulResponse;
    const answer = data?.answers?.is_relevant;

    // Return the raw probability — caller decides threshold
    if (answer && answer.type === "noul" && typeof answer.noul === "number") {
      return answer.noul;
    }
  } catch (_) {
    // Silent fail for individual file checks
  }
  return 0;
}

// ---------------------------------------------------------------------------
// File tree traversal
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "__pycache__", ".venv", "venv"]);
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
  ".mp4", ".mp3", ".wav", ".avi", ".mov",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".woff", ".woff2", ".ttf", ".eot",
]);

function getFilesRecursively(dir: string, fileList: string[] = []): string[] {
  if (!fs.existsSync(dir)) return fileList;

  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    fileList.push(dir);
    return fileList;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return fileList;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;

    const fullPath = path.join(dir, entry);
    let entryStat: fs.Stats;
    try {
      entryStat = fs.statSync(fullPath);
    } catch (_) {
      continue;
    }

    if (entryStat.isDirectory()) {
      getFilesRecursively(fullPath, fileList);
    } else if (entryStat.isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      if (!BINARY_EXTS.has(ext)) {
        fileList.push(fullPath);
      }
    }
  }

  return fileList;
}

// ---------------------------------------------------------------------------
// Main scan function
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 500_000; // ~500KB
const BATCH_SIZE = 5;
const MAX_MATCHES = 3;

export async function runScan(query: string, targetPath: string): Promise<void> {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      "Error: OpenRouter API key not found. Configure it with `opencode-jev panel`."
    );
    process.exit(1);
  }

  const absolutePath = path.resolve(process.cwd(), targetPath);
  console.log(`Scanning: ${absolutePath}`);
  console.log(`Query:    "${query}"\n`);

  const files = getFilesRecursively(absolutePath);
  console.log(`Files to scan: ${files.length}`);

  let foundMatches = 0;

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);

    const promises = batch.map(async (file) => {
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE_SIZE) return null;

        const content = fs.readFileSync(file, "utf8");
        const probability = await askJev(apiKey, query, content);

        if (probability >= NOUL_RELEVANCE_THRESHOLD) {
          return { file, probability };
        }
      } catch (_) {
        // skip unreadable files
      }
      return null;
    });

    const results = await Promise.all(promises);

    for (const res of results) {
      if (res) {
        const pct = (res.probability * 100).toFixed(0);
        console.log(`[MATCH ${pct}%] ${res.file}`);
        foundMatches++;
      }
    }

    if (foundMatches >= MAX_MATCHES) {
      console.log(
        `\nStopped early: ${foundMatches} matches found. Read these files to continue.`
      );
      return;
    }
  }

  if (foundMatches === 0) {
    console.log("No files matched the query.");
  } else {
    console.log(`\nScan complete. Found ${foundMatches} matches.`);
  }
}
