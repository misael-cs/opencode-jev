export const CORE_CATEGORIES: Record<string, string> = {
  FS_READ: "Read code, read files, explore directories, search for files or inspect content in the local repository.",
  FS_WRITE: "Write, edit, modify or create new source code files.",
  OS_EXECUTION: "Run scripts (.ps1, .sh), start containers (docker), servers, or execute commands in the terminal/shell.",
  WEB_AUTOMATION: "Automated web tests, browser control (Playwright), page inspection or web scraping.",
  KNOWLEDGE_RETRIEVAL: "Search for documentation on the internet, Google searches, or read external reference guides.",
  WORKFLOW_CONTROL: "Create task lists (TODO), ask the user for additional information, or delegate sub-agents.",
  FINAL_ANSWER: "Only respond discursively when no file or terminal action is required. The task is fully complete or you are just answering a conversational question.",
};

export const MCP_CATALOG: Record<string, string> = {
  obsidian: "Semantic search and retrieval from an Obsidian knowledge base. Exploring notes, second-brain data, and markdown documentation nodes.",
  postgres: "Database operations, SQL queries, inspecting tables, schemas, and columns in a PostgreSQL database.",
  mysql: "Database operations, SQL queries, inspecting tables, schemas, and columns in a MySQL database.",
  github: "Interact with GitHub repositories, read issues, pull requests, create commits, branches, or manage repository settings.",
  aws: "Interact with Amazon Web Services, manage EC2, S3, Lambda, IAM, or other cloud infrastructure.",
  hostinger: "Manage Hostinger web hosting, VPS, DNS records, domain names, or websites.",
  puppeteer: "Automate browser interaction, web scraping, and visual testing using Puppeteer.",
  brave: "Perform Brave Search queries to find real-time information from the web.",
  sqlite: "Database operations, executing SQL queries, and inspecting tables in a local SQLite database.",
  slack: "Read or send messages in Slack channels, interact with team communication.",
};

/**
 * Returns a dynamic criteria object containing core tools and any detected MCP tools.
 */
export function buildDynamicCriteria(mcpConfig: Record<string, unknown> | undefined): Record<string, string> {
  const criteria: Record<string, string> = { ...CORE_CATEGORIES };

  if (mcpConfig && typeof mcpConfig === 'object') {
    for (const mcpServerName of Object.keys(mcpConfig)) {
      // Clean up server name (e.g., "mcp-obsidian" -> "obsidian")
      const normalizedName = mcpServerName.toLowerCase().replace(/^(mcp-|-mcp)/, '');
      
      let description = undefined;
      
      // Try to find a match in the catalog
      for (const [key, val] of Object.entries(MCP_CATALOG)) {
        if (normalizedName.includes(key) || mcpServerName.toLowerCase().includes(key)) {
          description = val;
          break;
        }
      }

      if (description) {
        const key = `MCP_${normalizedName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
        criteria[key] = description;
      } else {
        // Fallback for unknown MCPs: we tell JEV it's an external MCP tool
        const key = `MCP_${mcpServerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
        criteria[key] = `External MCP server tool: ${mcpServerName}. Use this if the user asks for operations related to ${mcpServerName}.`;
      }
    }
  }

  return criteria;
}