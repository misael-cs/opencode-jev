# Recursive Search & Classification via JEV

When you need to find unstructured data, concepts, rules, or information spread across many files (such as an Obsidian knowledge base or large codebases), **DO NOT USE `grep`**. `grep` is for exact string matching and will fail on semantic queries.

Instead, use the JEV algorithmic scanner CLI. It leverages a high-speed O(1) semantic classifier to iterate through nodes until it finds the answer.

## Usage

```bash
npx opencode-jev scan "Does this contain the database connection rules?" ./vault/
```

### Algorithm & Workflow
1. The `scan` command will recursively chunk and send each file to JEV in parallel.
2. JEV will evaluate if the file answers your question.
3. The CLI will immediately output the first file(s) that JEV classified as a match (`YES` with >60% confidence).
4. Once you receive the matching file path, you can then use your `read` tool on that specific file.
5. If the scan returns no results, refine your question and run the scan again.

This approach saves massive amounts of context window tokens, as you don't need to read dozens of irrelevant files.