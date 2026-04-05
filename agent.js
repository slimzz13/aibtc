const { spawn } = require('child_process');
const http = require('http');
const cron = require('node-cron');

// Render Web Service Health Check
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('AIBTC Agent is running natively!');
}).listen(PORT, () => {
    console.log(`Web service listening on port ${PORT} for Render health checks.`);
});

// Start the aibtc mcp server and bind to it
const mcp = spawn(/^win/.test(process.platform) ? 'npx.cmd' : 'npx', ['@aibtc/mcp-server'], { shell: true });
let callId = 1;

// Self-Ping Uptime Bot (Keeps Render Free Tier Awake)
setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL;
    if (url) {
        http.get(url, (res) => {
            console.log(`[Uptime Bot] Self-ping successful: ${res.statusCode}`);
        }).on('error', (e) => {
            console.error(`[Uptime Bot] Self-ping failed: ${e.message}`);
        });
    } else {
        console.log("[Uptime Bot] Running locally. Skipping self-ping.");
    }
}, 1000 * 60 * 14); // Ping every 14 minutes

function rpcCall(method, params = {}) {
    const payload = JSON.stringify({
        jsonrpc: "2.0",
        method,
        id: callId++,
        params
    });
    console.log(`[>> RPC OUT]: Method: ${method}`);
    mcp.stdin.write(payload + '\n');
}

mcp.stdout.on('data', (data) => {
    const str = data.toString();
    console.log(`[<< RPC IN]: ${str}`);
});

mcp.stderr.on('data', (data) => {
    console.error(`[!! RPC ERR]: ${data.toString()}`);
});

// Boot Sequence
setTimeout(() => {
    console.log("==> Unlocking Wallet...");
    rpcCall("tools/call", {
        name: "wallet_unlock",
        arguments: { password: process.env.WALLET_PASSWORD } // Securely read from Render environment variables
    });
}, 3000);

// Signal posting schedule — times in UTC (user is PDT = UTC-7):
// 09:00 PDT = 16:00 UTC  (Morning)
// 13:00 PDT = 20:00 UTC  (Afternoon)
// 18:00 PDT = 01:00 UTC  (Evening, next UTC day)
cron.schedule('0 16,20,1 * * *', () => {
    const now = new Date().toISOString();
    console.log(`==> [${now}] Scheduled signal posting triggered...`);

    // Step 1: Re-unlock wallet (in case session expired)
    rpcCall("tools/call", {
        name: "wallet_unlock",
        arguments: { password: process.env.WALLET_PASSWORD }
    });

    // Step 2: Search arxiv for fresh AIBTC-relevant research
    setTimeout(() => {
        console.log("==> Searching for fresh AIBTC/Stacks security research...");
        rpcCall("tools/call", {
            name: "arxiv_search",
            arguments: { categories: "cs.CR,cs.AI", max_results: 1 }
        });
    }, 2000);

}, { timezone: "UTC" });

console.log("Agent Loop Initialized. Waiting for MCP Server to start...");
