import {
  COMPLEX_THRESHOLD,
  CONFIG_DIR,
  ESCALATION_FAILURE_THRESHOLD,
  extractWords,
  FAILURE_WINDOW_MS,
  getOpencodeConfigDir,
  isToolSafeReadonly,
  normalizeMcpServerName,
  sampleForHarvest,
  TRIVIAL_THRESHOLD,
} from "./shared.js";

describe("shared module", () => {
  describe("getOpencodeConfigDir", () => {
    it("should return a valid config directory path", () => {
      const dir = getOpencodeConfigDir();
      expect(dir).toContain("opencode");
      expect(typeof dir).toBe("string");
    });

    it("CONFIG_DIR should match getOpencodeConfigDir()", () => {
      expect(CONFIG_DIR).toBe(getOpencodeConfigDir());
    });
  });

  describe("normalizeMcpServerName", () => {
    it("should strip the mcp- prefix", () => {
      expect(normalizeMcpServerName("mcp-obsidian")).toBe("obsidian");
      expect(normalizeMcpServerName("-mcp-obsidian")).toBe("-obsidian");
    });

    it("should keep names without a prefix untouched", () => {
      expect(normalizeMcpServerName("obsidian")).toBe("obsidian");
    });
  });

  describe("extractWords", () => {
    it("should split separators AND camelCase", () => {
      expect(extractWords("agency-hosting_getWebsiteSetupStatusV1")).toEqual([
        "agency",
        "hosting",
        "get",
        "website",
        "setup",
        "status",
        "v1",
      ]);
    });

    it("should handle simple MCP-style names", () => {
      expect(extractWords("listWebsitesV1")).toEqual(["list", "websites", "v1"]);
    });
  });

  describe("isToolSafeReadonly", () => {
    it("should trust exact safe names", () => {
      expect(isToolSafeReadonly("read")).toBe(true);
      expect(isToolSafeReadonly("glob")).toBe(true);
    });

    it("should skip tools starting with a read-only verb", () => {
      expect(isToolSafeReadonly("listWebsitesV1")).toBe(true);
      expect(isToolSafeReadonly("getDNSRecords")).toBe(true);
    });

    it("should never skip tools with a whole-word write verb", () => {
      expect(isToolSafeReadonly("createWebsiteV1")).toBe(false);
      expect(isToolSafeReadonly("deleteNote")).toBe(false);
    });

    it("should never skip compound operation names", () => {
      expect(isToolSafeReadonly("get_or_create")).toBe(false);
    });

    it("should skip server prefixes to find the read-only verb", () => {
      expect(isToolSafeReadonly("vps_VPS_listInstances")).toBe(true);
    });
  });

  describe("thresholds", () => {
    it("should expose the canonical routing constants", () => {
      expect(TRIVIAL_THRESHOLD).toBe(0.6);
      expect(COMPLEX_THRESHOLD).toBe(1.5);
      expect(ESCALATION_FAILURE_THRESHOLD).toBe(2);
      expect(FAILURE_WINDOW_MS).toBe(5 * 60 * 1000);
    });
  });

  describe("sampleForHarvest", () => {
    it("should return the original text when within the limit", () => {
      expect(sampleForHarvest("Hello world", 100)).toBe("Hello world");
    });

    it("should keep the head and the tail, dropping the middle", () => {
      const text = "A".repeat(2000) + "B".repeat(3000);
      const out = sampleForHarvest(text, 1000);
      expect(out.startsWith("A".repeat(200))).toBe(true);
      expect(out.endsWith("B".repeat(800))).toBe(true);
      expect(out).toContain("[...middle 4000 chars sampled out...]");
    });
  });
});
