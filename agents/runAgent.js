// A small, generic agent loop: the model decides which of its (narrow) tools
// to call, we execute them, feed results back, and repeat until it answers.
// Uses OpenAI's Chat Completions API with function calling.
// Mock mode runs each agent's deterministic fallback with the same tools,
// so you can rehearse without an API key and get identical terminal output.
import OpenAI from "openai";
import { cfg } from "../config.js";
import { log } from "../lib/log.js";

let client;
const MAX_TURNS = 8;

const JSON_RULES = `

When you have finished investigating, reply with ONLY a JSON object matching the
requested shape. No prose before or after it, no markdown code fences.`;

function parseJson(text) {
  const clean = (text || "").replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`Agent did not return JSON: ${clean.slice(0, 200)}`);
  return JSON.parse(clean.slice(start, end + 1));
}

export async function runAgent({ name, system, task, tools = [], mock }) {
  log.agent(name, `started${cfg.agentMode === "mock" ? " (mock mode)" : ` (${cfg.model})`}`);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const callTool = async (toolName, input = {}) => {
    log.tool(name, toolName, input);
    const tool = byName[toolName];
    if (!tool) throw new Error(`Unknown tool ${toolName}`);
    return tool.run(input);
  };

  if (cfg.agentMode === "mock") {
    const result = await mock(callTool);
    log.result(name, result);
    return result;
  }

  client ||= new OpenAI(); // reads OPENAI_API_KEY (and OPENAI_BASE_URL if set)
  const toolSpecs = tools.map(({ name, description, input_schema }) => ({
    type: "function",
    function: { name, description, parameters: input_schema },
  }));
  const messages = [
    { role: "system", content: system + JSON_RULES },
    { role: "user", content: task },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.chat.completions.create({
      model: cfg.model,
      messages,
      ...(toolSpecs.length ? { tools: toolSpecs } : {}),
    });
    const message = response.choices[0].message;
    messages.push(message);

    if (!message.tool_calls?.length) {
      const result = parseJson(message.content);
      log.result(name, result);
      return result;
    }

    // The model may ask for several tools at once; run them and return every result.
    for (const call of message.tool_calls) {
      let content;
      try {
        const input = JSON.parse(call.function.arguments || "{}");
        content = JSON.stringify(await callTool(call.function.name, input));
      } catch (err) {
        content = JSON.stringify({ error: err.message });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  throw new Error(`${name} did not finish within ${MAX_TURNS} turns`);
}
