import fs from "fs";
import path from "path";
import { parse } from "jsonc-parser";
import os from "os";

// Helper to get API key (similar to plugin.ts)
function getOpencodeConfigDir(): string {
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Roaming", "opencode");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "opencode") : path.join(os.homedir(), ".config", "opencode");
}

function resolveApiKey(): string | undefined {
  const envKey = process.env.OPENROUTER_API_KEY;
  if (envKey) return envKey;

  try {
    const configPath = path.join(getOpencodeConfigDir(), "opencode.jsonc");
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      const config = parse(raw) as Record<string, unknown>;
      const provider = config?.provider as Record<string, unknown> | undefined;
      const openrouter = provider?.openrouter as Record<string, unknown> | undefined;
      const options = openrouter?.options as Record<string, unknown> | undefined;
      const key = options?.apiKey as string | undefined;
      
      if (key) {
        if (key.startsWith("{env:") && key.endsWith("}")) {
          const envName = key.slice(5, -1);
          return process.env[envName];
        }
        return key;
      }
    }
  } catch (e) {
    // ignore
  }

  return undefined;
}

async function askJev(apiKey: string, question: string, contextString: string): Promise<boolean> {
  try {
    const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "typesafe/jev-1.13",
        questions: {
          contains_answer: {
            type: "choice",
            instructions: `Does the provided text contain the answer to or match the intent of the following query? Query: "${question}"`,
            criteria: {
              YES: "The text clearly contains information that answers the query, or is highly relevant to it.",
              NO: "The text does not contain the answer, or is completely unrelated.",
            },
          },
        },
        state: { context: contextString.substring(0, 32000) }, // Limit to prevent payload too large
      }),
    });

    if (!response.ok) return false;
    
    const data = await response.json() as any;
    const answer = data?.answers?.contains_answer;
    
    if (answer && answer.choice === "YES" && typeof answer.confidence === "number" && answer.confidence > 0.6) {
      return true;
    }
  } catch (err) {
    // Silent fail for individual chunks
  }
  return false;
}

function getFilesRecursively(dir: string, fileList: string[] = []): string[] {
  if (!fs.existsSync(dir)) return fileList;
  
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    fileList.push(dir);
    return fileList;
  }
  
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    // Skip common heavy directories
    if (file === "node_modules" || file === ".git" || file === "dist") continue;
    if (fs.statSync(filePath).isDirectory()) {
      getFilesRecursively(filePath, fileList);
    } else {
      // Only process likely text files based on extension, or files with no extension
      const ext = path.extname(filePath).toLowerCase();
      const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.tar', '.gz', '.mp4', '.exe', '.dll'];
      if (!binaryExts.includes(ext)) {
        fileList.push(filePath);
      }
    }
  }
  return fileList;
}

export async function runScan(question: string, targetPath: string): Promise<void> {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error("Error: OpenRouter API key not found. Please configure it using `opencode-jev panel`.");
    process.exit(1);
  }

  const absolutePath = path.resolve(process.cwd(), targetPath);
  console.log(`Scanning path: ${absolutePath}`);
  console.log(`Looking for: "${question}"\n`);
  
  const files = getFilesRecursively(absolutePath);
  let foundMatches = 0;

  // We can process in batches to not overwhelm the API
  const BATCH_SIZE = 5;
  
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    
    const promises = batch.map(async (file) => {
      try {
        const content = fs.readFileSync(file, "utf8");
        // Skip huge minified files
        if (content.length > 500000) return null;
        
        const isMatch = await askJev(apiKey, question, content);
        if (isMatch) {
          return file;
        }
      } catch (e) {
        // e.g. file reading errors due to binary content
      }
      return null;
    });

    const results = await Promise.all(promises);
    for (const res of results) {
      if (res) {
        console.log(`[MATCH FOUND] -> ${res}`);
        foundMatches++;
      }
    }
    
    // Stop early if we found enough matches to give to the LLM (e.g. 3)
    if (foundMatches >= 3) {
      console.log(`\nStopping scan early as ${foundMatches} matches were found. Read these files to continue.`);
      return;
    }
  }

  if (foundMatches === 0) {
    console.log("No files matched the query.");
  } else {
    console.log(`\nScan complete. Found ${foundMatches} matches.`);
  }
}