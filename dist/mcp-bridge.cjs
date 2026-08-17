"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/mcpBridge.ts
var http = __toESM(require("http"));
var readline = __toESM(require("readline"));
var PORT = 37492;
var BASE = `http://127.0.0.1:${PORT}`;
function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
    }).on("error", reject);
  });
}
function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port: PORT, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
async function checkExtension() {
  try {
    const r = await httpGet("/health");
    return r.ok === true;
  } catch {
    return false;
  }
}
async function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    let req;
    try {
      req = JSON.parse(line.trim());
    } catch {
      sendError(null, -32700, "Parse error");
      return;
    }
    const { id, method, params } = req;
    switch (method) {
      case "initialize":
        send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "notevs-mcp", version: "1.0.0" } } });
        break;
      case "notifications/initialized":
        break;
      case "tools/list":
        try {
          const r = await httpGet("/tools");
          send({ jsonrpc: "2.0", id, result: { tools: r.tools ?? [] } });
        } catch {
          sendError(id, -32603, "NoteVs extension not running. Open VS Code with NoteVs installed.");
        }
        break;
      case "tools/call": {
        const alive2 = await checkExtension();
        if (!alive2) {
          sendError(id, -32603, "NoteVs extension not running. Open VS Code with NoteVs installed.");
          break;
        }
        const { name, arguments: args = {} } = params;
        const enrichedArgs = { folderPath: process.cwd(), ...args };
        try {
          const r = await httpPost("/call", { tool: name, args: enrichedArgs });
          if (r.error) {
            sendError(id, -32603, r.error);
            break;
          }
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r.result, null, 2) }], isError: false } });
        } catch (err) {
          sendError(id, -32603, `Tool call failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  });
  rl.on("close", () => {
    process.exit(0);
  });
  const alive = await checkExtension();
  process.stderr.write(alive ? `[NoteVs MCP] Connected. Scoping notes to: ${process.cwd()}
` : "[NoteVs MCP] Warning: VS Code extension not detected on port 37492.\n");
}
main().catch((err) => {
  process.stderr.write(`[NoteVs MCP] Fatal: ${err}
`);
  process.exit(1);
});
